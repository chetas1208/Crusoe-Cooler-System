"""V7 render-asset endpoints.

* ``GET /api/v1/facilities/{id}/render-manifest?rev=``  (also ``/api/v1/render-manifest`` and
  ``/api/v1/runs/{run_id}/render-manifest`` - the run form compiles from THAT run's recorded topology)
* ``GET|HEAD /assets/sha256/{hash}``  (mirrored at ``/api/v1/assets/sha256/{hash}`` for same-prefix proxies)

Assets are content-addressed: URL == sha256 of the identity bytes, so they are served ``public, immutable`` for a year with
a strong ETag and no auth (a 256-bit hash is the capability; tiles hold only simulated-facility geometry).  The manifest
is ``no-cache`` + ETag (= manifest_id) when fetched "as current" and ``immutable`` when pinned by ``rev=<manifest_id>``.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from .context import RunScope, run_scope
from .stream import assets_service

router = APIRouter()
asset_router = APIRouter()
IMMUTABLE = "public, max-age=31536000, immutable"
_HASH = re.compile(r"^[0-9a-f]{64}$")


def _etag_match(header: Optional[str], etag: str) -> bool:
    if not header:
        return False
    if header.strip() == "*":
        return True
    return any(t.strip().removeprefix("W/").strip('"') == etag for t in header.split(","))


def _accepts_gzip(request: Request) -> bool:
    return "gzip" in request.headers.get("accept-encoding", "").lower()


def _respond(request: Request, body: bytes, gz: Optional[bytes], *, etag: str, ctype: str, cache: str, extra: Optional[dict[str, str]] = None) -> Response:
    headers = {"ETag": f'"{etag}"', "Cache-Control": cache, "Vary": "Accept-Encoding", "Cross-Origin-Resource-Policy": "cross-origin",
               "Access-Control-Expose-Headers": "ETag, X-LK-Manifest-Id, X-LK-Layout-Hash, X-LK-Raw-Bytes", **(extra or {})}
    if _etag_match(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    if gz is not None and len(gz) < len(body) and _accepts_gzip(request):
        headers["Content-Encoding"] = "gzip"
        out = gz
    else:
        out = body
    headers["X-LK-Raw-Bytes"] = str(len(body))
    if request.method == "HEAD":
        headers["Content-Length"] = str(len(out))
        return Response(status_code=200, headers=headers, media_type=ctype)
    return Response(content=out, media_type=ctype, headers=headers)


@router.get("/render-manifest", include_in_schema=True)
@router.get("/facilities/{facility_id}/render-manifest")
@router.get("/runs/{run_id}/render-manifest")
def render_manifest(request: Request, rev: Optional[str] = None, facility_id: Optional[str] = None, sc: RunScope = Depends(run_scope("read"))):
    svc = assets_service(request.app)
    topo = sc.engine.topology()
    fac = topo.get("facility", {})
    if facility_id and facility_id != fac.get("id"):
        raise HTTPException(404, "unknown facility")
    if rev is not None and (len(rev) > 160 or not re.fullmatch(r"[A-Za-z0-9_.@#:/-]+", rev)):
        raise HTTPException(422, "invalid rev")
    try:
        cur = svc.compiled_for(topo)
    except Exception:
        raise HTTPException(503, "render manifest unavailable")
    c = cur
    if rev is not None and rev not in (fac.get("topology_version"), fac.get("topology_hash"), cur.manifest_id, cur.manifest["cache_key"], cur.topology_digest):
        c = svc.find_rev(rev)
        if c is None:   # not the run's layout and not a layout we still hold: tell the client what is current
            raise HTTPException(404, "unknown revision; current manifest_id=" + cur.manifest_id, headers={
                "X-Problem-Code": "unknown_revision", "X-LK-Manifest-Id": cur.manifest_id})
    pinned = rev == c.manifest_id
    return _respond(request, c.manifest_bytes, svc.manifest_gzip(c.manifest_id), etag=c.manifest_id, ctype="application/json",
                    cache=IMMUTABLE if pinned else "no-cache", extra={"X-LK-Manifest-Id": c.manifest_id, "X-LK-Layout-Hash": c.manifest["layout_hash"]})


def _asset(request: Request, h: str) -> Response:
    if not _HASH.match(h):
        raise HTTPException(404, "not found")
    blob = assets_service(request.app).blob(h)
    if blob is None:
        raise HTTPException(404, "asset not found (compile a manifest first, or the layout was evicted)")
    body, gz, ctype = blob
    return _respond(request, body, gz, etag=h, ctype=ctype, cache=IMMUTABLE)


@asset_router.api_route("/assets/sha256/{h}", methods=["GET", "HEAD"], include_in_schema=False)
def asset_root(request: Request, h: str) -> Response:
    return _asset(request, h)


@router.api_route("/assets/sha256/{h}", methods=["GET", "HEAD"], include_in_schema=False)
def asset_api(request: Request, h: str) -> Response:
    return _asset(request, h)
