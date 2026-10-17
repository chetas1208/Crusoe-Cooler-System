"""WebSocket /api/v1/stream — snapshot-first, ordered, resumable, secret-free.

Semantics (documented in backend/README.md):
* New subscriber (no/0/stale/ahead-of-head ``since_seq``, or ``snapshot=always``) -> first frame is ``snapshot``
  (seq == world.last_seq), then every later event in order.
* Resume (``0 < since_seq <= head`` and the engine can serve a contiguous log) -> NO snapshot; the missed events
  ``since_seq+1..`` are replayed in order, then live. The stock client already holds a /world snapshot at that seq.
* Gap (engine log no longer covers since_seq+1, or the live subscription skips a seq) -> a fresh ``snapshot`` is
  sent and the stream continues from its seq.  seq is strictly increasing on the wire.
* Interest management (V7, opt-in): after connecting a client may send a ``subscribe`` frame (see
  ``assets/interest.py``); the server then throttles ``robot.pose`` per robot (selected / visible / background tiers,
  total rate budget). Elided seqs are counted in ``elided`` on the next event so gap detection still works; the
  simulation never notices. Without a ``subscribe`` frame the stream is unchanged. ``asset.manifest_changed`` is
  pushed (non-seq-advancing) when the facility's render manifest changes.
* Auth: Authorization header, ``Sec-WebSocket-Protocol: loopkeeper.v1, bearer.<token>``, or a first
  ``{"type":"auth","token":...}`` frame. Never the URL.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect

from ..assets.interest import InterestError, InterestManager, ZoneIndex
from ..assets.store import AssetService
from ..interfaces import Json
from .auth import Principal, bearer_from_header
from .context import ApiContext
from .scrub import scrub
from .service import now_iso

SUBPROTOCOL = "loopkeeper.v1"
CLOSE_BAD_REQUEST = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_NOT_FOUND = 4404
CLOSE_TOO_BIG = 1009
INTEREST_MAX_BYTES = 16384        # subscribe frames may exceed ws_max_message_bytes (long visible_zone_ids lists) up to this
MANIFEST_POLL_S = 2.0


class StreamState:
    """Per-connection mutable state shared by the sender, receiver and manifest-watch tasks (one event loop -> no races)."""

    def __init__(self, ws: WebSocket, ctx: ApiContext, engine: Any, run_id: str) -> None:
        self.ws, self.ctx, self.engine, self.run_id = ws, ctx, engine, run_id
        self.lock = asyncio.Lock()
        self.assets = assets_service(ws.app)
        self.interest = InterestManager(self._zone_index())
        self.last_seq = 0
        self.manifest_key: Optional[str] = None
        self.manifest_id_sent: Optional[str] = None

    def _zone_index(self) -> Optional[ZoneIndex]:
        try:
            return ZoneIndex(self.assets.partition_for(self.engine.topology()).zones)
        except Exception:      # topology without a V6 layout (test doubles): interest still works zone-less
            return None

    async def send_json(self, obj: Json) -> None:
        async with self.lock:
            await asyncio.wait_for(self.ws.send_text(json.dumps(scrub(obj), separators=(",", ":"))), self.ctx.settings.ws_send_timeout_s)


def assets_service(app: Any) -> AssetService:
    svc = getattr(app.state, "assets", None)
    if svc is None:
        svc = app.state.assets = AssetService()
    return svc


def snapshot_event(world: Json, run_id: str) -> Json:
    seq = int(world.get("last_seq", 0))
    return {
        "event_id": f"snap_{seq}", "seq": seq, "sim_tick": world.get("sim_tick", 0),
        "sim_time_s": world.get("sim_time_s", 0), "world_version": world.get("version", 0),
        "type": "snapshot", "entity_id": world.get("facility_id", ""),
        "facility_id": world.get("facility_id", ""), "ts": now_iso(), "run_id": run_id, "payload": world,
    }


def _tokens_from_subprotocols(ws: WebSocket) -> tuple[Optional[str], Optional[str]]:
    offered = [p.strip() for p in ws.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
    token = next((p[len("bearer."):] for p in offered if p.startswith("bearer.")), None)
    return (SUBPROTOCOL if SUBPROTOCOL in offered else None), token


async def _authenticate(ws: WebSocket, ctx: ApiContext, token: Optional[str]) -> Optional[Principal]:
    p = ctx.authenticate(token)
    if p is not None:
        return p
    if token:  # a presented token that is wrong never gets a second chance
        return None
    try:  # first-message auth
        raw = await asyncio.wait_for(ws.receive_text(), ctx.settings.ws_auth_timeout_s)
        if len(raw) > ctx.settings.ws_max_message_bytes:
            return None
        msg = json.loads(raw)
        if isinstance(msg, dict) and msg.get("type") == "auth" and isinstance(msg.get("token"), str):
            return ctx.authenticate(msg["token"])
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError, RuntimeError):
        return None
    return None


async def _send(st: StreamState, ev: Json, run_id: str) -> None:
    out = scrub(st.interest.annotate(ev))
    out.setdefault("run_id", run_id)
    async with st.lock:
        await asyncio.wait_for(st.ws.send_text(json.dumps(out, separators=(",", ":"))), st.ctx.settings.ws_send_timeout_s)
    seq = int(out.get("seq", 0) or 0)
    if seq > st.last_seq or out.get("type") == "snapshot":
        st.last_seq = seq


async def stream_endpoint(ws: WebSocket) -> None:
    ctx: ApiContext = ws.app.state.ctx
    sub_proto, header_token = _tokens_from_subprotocols(ws)
    token = bearer_from_header(ws.headers.get("authorization")) or header_token
    await ws.accept(subprotocol=sub_proto)

    principal = await _authenticate(ws, ctx, token)
    if principal is None:
        await ws.close(code=CLOSE_UNAUTHORIZED, reason="unauthorized")
        return

    q = ws.query_params
    run_id = ctx.resolve_run_id(q.get("run_id"))
    engine = ctx.runs.engine_for(run_id) if principal.can("read", run_id) else None
    if engine is None:
        await ws.close(code=CLOSE_NOT_FOUND, reason="unknown run")
        return
    try:
        since = int(q["since_seq"]) if q.get("since_seq") not in (None, "") else 0
        if since < 0:
            raise ValueError
    except ValueError:
        await ws.close(code=CLOSE_BAD_REQUEST, reason="invalid since_seq")
        return
    fac = q.get("facility_id")
    if fac and fac != engine.world().get("facility_id"):
        await ws.close(code=CLOSE_NOT_FOUND, reason="unknown facility")
        return
    force_snapshot = q.get("snapshot") == "always"

    sub = engine.subscribe()
    st = StreamState(ws, ctx, engine, run_id)
    sender = asyncio.create_task(_pump(st, sub, since, force_snapshot))
    receiver = asyncio.create_task(_drain_client(st))
    watcher = asyncio.create_task(_manifest_watch(st))
    try:
        done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                raise exc
    except Exception:  # never leak internals to the client; the connection just ends
        pass
    finally:
        sub.close()
        for t in (sender, receiver, watcher):
            t.cancel()
        try:
            await ws.close()
        except Exception:
            pass


async def _drain_client(st: StreamState) -> None:
    """Clients send nothing after auth except optional ``subscribe`` (interest) frames; cap frame size, detect disconnects."""
    ws, ctx = st.ws, st.ctx
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        data = msg.get("text") or msg.get("bytes") or ""
        n = len(data)
        if n > INTEREST_MAX_BYTES:
            await ws.close(code=CLOSE_TOO_BIG, reason="message too large")
            return
        if not n:
            continue
        parsed = None
        if msg.get("text") and (n > ctx.settings.ws_max_message_bytes or '"subscribe"' in data or '"stream.' in data):
            try:
                parsed = json.loads(data)
            except ValueError:
                parsed = None
        is_interest = isinstance(parsed, dict) and parsed.get("type") in ("subscribe", "stream.interest", "stream.stats")
        if n > ctx.settings.ws_max_message_bytes and not is_interest:
            await ws.close(code=CLOSE_TOO_BIG, reason="message too large")
            return
        if not is_interest:
            continue
        await _handle_interest(st, parsed)


async def _handle_interest(st: StreamState, msg: Json) -> None:
    ids = {st.run_id} | ({"run_live"} if st.run_id == st.ctx.active_run_id else set())
    try:
        extra: Json = {}
        if msg["type"] != "stream.stats":
            extra = st.interest.apply(msg, connection_run_ids=ids)
        ack = st.interest.ack(extra)
    except InterestError as e:
        ack = {"accepted": False, "code": e.code, "reason": e.reason}
    await st.send_json({"type": "stream.interest", "seq": st.last_seq, "event_id": f"interest_{st.last_seq}", "run_id": st.run_id, "payload": ack})
    mid = st.interest.manifest_id
    if ack.get("accepted") and mid:
        await _announce_manifest(st, client_has=mid)


async def _announce_manifest(st: StreamState, client_has: Optional[str] = None) -> None:
    """Send ``asset.manifest_changed`` when the server's manifest differs from what the client (or we) last announced."""
    loop = asyncio.get_running_loop()
    topo = st.engine.topology()
    try:
        c = await loop.run_in_executor(None, st.assets.compiled_for, topo)
    except Exception:
        return
    st.manifest_key = st.assets.quick_key(topo)
    if client_has is not None and client_has == c.manifest_id:
        st.manifest_id_sent = c.manifest_id
        return
    if client_has is None and st.manifest_id_sent == c.manifest_id:
        return
    prev, st.manifest_id_sent = st.manifest_id_sent or client_has, c.manifest_id
    fac = topo.get("facility", {}).get("id") or ""
    await st.send_json({"type": "asset.manifest_changed", "seq": st.last_seq, "event_id": f"manifest_{c.manifest_id[:12]}", "run_id": st.run_id,
                        "entity_id": fac, "facility_id": fac, "ts": now_iso(),
                        "payload": {"manifest_id": c.manifest_id, "previous_manifest_id": prev, "layout_hash": c.manifest["layout_hash"],
                                    "topology_version": c.manifest["topology_version"], "manifest_version": c.manifest["manifest_version"],
                                    "url": f"/api/v1/facilities/{fac}/render-manifest?rev={c.manifest_id}"}})


async def _manifest_watch(st: StreamState) -> None:
    """Cheap poll (version strings only; compile happens only when the topology key moved)."""
    try:
        st.manifest_key = st.assets.quick_key(st.engine.topology())
        while True:
            await asyncio.sleep(MANIFEST_POLL_S)
            if st.assets.quick_key(st.engine.topology()) != st.manifest_key:
                await _announce_manifest(st)
    except asyncio.CancelledError:
        raise
    except Exception:
        return


async def _pump(st: StreamState, sub: Any, since: int, force_snapshot: bool) -> None:
    ctx, engine, run_id = st.ctx, st.engine, st.run_id
    interest = st.interest
    page = ctx.settings.ws_catchup_page
    world = engine.world()  # subscribed first, so nothing between here and the live loop is lost
    head = int(world.get("last_seq", 0))
    cursor: int

    backlog: list[Json] = []
    resume = (not force_snapshot) and 0 < since <= head
    if resume and since < head:
        cur = since
        while cur < head:
            evs = engine.events_since(cur, page)
            if not evs or int(evs[0]["seq"]) != cur + 1 or any(
                int(b["seq"]) != int(a["seq"]) + 1 for a, b in zip(evs, evs[1:])
            ):
                resume = False  # engine can't serve a contiguous tail -> gap -> snapshot
                break
            backlog.extend(evs)
            cur = int(evs[-1]["seq"])
    if resume:
        cursor = since
        for ev in backlog:
            cursor = int(ev["seq"])
            if not interest.should_drop(ev):
                await _send(st, ev, run_id)
    else:
        await _send(st, snapshot_event(world, run_id), run_id)
        cursor = head

    async for ev in sub:
        seq = int(ev["seq"])
        if seq <= cursor:
            continue
        if seq != cursor + 1:  # live subscription skipped events -> resync with a fresh snapshot
            w = engine.world()
            interest.elided = 0               # a snapshot supersedes whatever was elided
            await _send(st, snapshot_event(w, run_id), run_id)
            cursor = int(w.get("last_seq", seq))
            if seq <= cursor:
                continue
        cursor = seq
        if interest.should_drop(ev):          # elided pose: seq advances, nothing is sent, next event carries `elided`
            continue
        await _send(st, ev, run_id)
