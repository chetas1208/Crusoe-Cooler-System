"""V7 render assets: partition, deterministic geometry compiler, manifest + content-addressed asset endpoints."""
from __future__ import annotations

import copy
import hashlib

import numpy as np
import pytest

from loopkeeper.assets.compiler import MANIFEST_VERSION, compile_facility, validate_tile
from loopkeeper.assets.glb import parse_glb, read_accessor
from loopkeeper.assets.partition import build_partition
from loopkeeper.assets.store import AssetService
from loopkeeper.physics.config import load_config
from loopkeeper.physics.topology import build_topology
from support.fixtures import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(scope="module")
def topo():
    return build_topology(load_config())


@pytest.fixture(scope="module")
def comp(topo):
    return compile_facility(topo)


# ------------------------------------------------------------------ partition
def test_partition_zones_cover_v6_layout(topo):
    p = build_partition(topo)
    kinds = {z.kind for z in p.zones.values()}
    assert {"shell", "row", "road", "cross_aisle", "plant", "trunk", "dock", "rack", "service", "pipe"} <= kinds
    assert [z for z in p.zones if z.startswith("ROW-")] == [f"ROW-0{i}" for i in range(1, 6)]
    assert len([z for z in p.zones.values() if z.kind == "road"]) == 8 and len([z for z in p.zones.values() if z.kind == "rack"]) == 40
    # every asset and edge has exactly one primary zone
    for a in topo["assets"]:
        assert a["id"] in p.entity_zone, a["id"]
    for e in topo["edges"]:
        assert p.edge_zone[e["id"]] in p.zones
    owned = [e for z in p.zones.values() for e in z.entity_ids]
    assert len(owned) == len(set(owned)), "an entity has two primary zones"


def test_partition_bounds_contain_entities(topo):
    p = build_partition(topo)
    for a in topo["assets"]:
        z = p.zones[p.entity_zone[a["id"]]]
        if a["type"] == "dock":     # dock geometry rides in its road cell
            z = p.zones[p.entity_zone[a["id"]]]
        x, y, zz = a["position_xyz_m"]
        # zone bounds were built from the same boxes (+/- pad): the anchor must be inside in x/z
        if z.kind in ("row", "road", "plant", "trunk"):
            assert z.bounds_min[0] - 1e-6 <= x <= z.bounds_max[0] + 1e-6, (a["id"], z.zone_id)
            assert z.bounds_min[2] - 1e-6 <= zz <= z.bounds_max[2] + 1e-6, (a["id"], z.zone_id)


def test_pipe_chunks_cover_each_passable_edge(topo):
    p = build_partition(topo)
    for e in topo["edges"]:
        ch = p.pipe_chunks.get(e["id"])
        if not e["robot_passable"]:
            assert ch is None
            continue
        assert ch[0]["s_lo_m"] == 0 and abs(ch[-1]["s_hi_m"] - e["length_m"]) < 1e-6
        assert all(abs(a["s_hi_m"] - b["s_lo_m"]) < 1e-6 for a, b in zip(ch, ch[1:]))
        assert all(c["s_hi_m"] - c["s_lo_m"] <= 4.0 + 1e-6 for c in ch)
    # junction neighbourhood: p_hs_a chunk 1 touches the trunk tee neighbours
    assert any(n.startswith("PS-p_14") for n in p.zones["PS-p_hs_a-01"].neighbors)


def test_zone_ids_are_stable_across_builds(topo):
    a, b = build_partition(topo), build_partition(copy.deepcopy(topo))
    assert list(a.zones) == list(b.zones)
    assert {k: z.to_json() for k, z in a.zones.items()} == {k: z.to_json() for k, z in b.zones.items()}


# ------------------------------------------------------------------ compiler
def test_compile_is_deterministic_and_hash_addressed(topo, comp):
    again = compile_facility(copy.deepcopy(topo))
    assert again.manifest_id == comp.manifest_id and again.manifest_bytes == comp.manifest_bytes
    for t in comp.manifest["tiles"]:
        data, gz, ctype = comp.blobs[t["sha256"]]
        assert hashlib.sha256(data).hexdigest() == t["sha256"] and ctype == "model/gltf-binary"
        assert t["bytes"] == len(data) and t["bytes_gzip"] == len(gz) and t["url"] == f"/assets/sha256/{t['sha256']}"
    f = comp.manifest["features"]
    assert hashlib.sha256(comp.blobs[f["sha256"]][0]).hexdigest() == f["sha256"]


def test_manifest_keys_and_changes_with_layout(topo, comp):
    m = comp.manifest
    assert m["manifest_version"] == MANIFEST_VERSION and m["layout_hash"] == topo["facility"]["topology_hash"]
    assert m["topology_version"] == topo["facility"]["topology_version"] and m["cache_key"].startswith(m["layout_hash"])
    moved = copy.deepcopy(topo)
    next(a for a in moved["assets"] if a["id"] == "rack_a1")["position_xyz_m"][0] += 0.1
    other = compile_facility(moved)
    assert other.manifest_id != comp.manifest_id and other.topology_digest != comp.topology_digest
    # unchanged zones keep their tile hashes (immutable tiles are reused across layouts)
    same = {t["tile_id"]: t["sha256"] for t in comp.manifest["tiles"]}
    same2 = {t["tile_id"]: t["sha256"] for t in other.manifest["tiles"]}
    assert same["RACK-B1@L2"] == same2["RACK-B1@L2"] and same["RACK-A1@L2"] != same2["RACK-A1@L2"]


def test_lod_levels_and_budget(comp):
    m = comp.manifest
    lv = {l["lod"]: l for l in m["levels"]}
    assert all(lv[i]["available"] for i in range(4)) and m["omitted"] == []
    assert lv[0]["tiles"] == 1
    l0 = next(t for t in m["tiles"] if t["lod"] == 0)
    assert l0["tile_id"] == "SHELL@L0" and l0["bytes_gzip"] <= 3_000_000 and l0["instances"] >= 40 and l0["line_segments"] > 0
    assert m["limits"]["lod0_bytes_gzip"] == l0["bytes_gzip"]
    # geometric error strictly decreases with LOD
    ge = [lv[i]["geometric_error_m"] for i in range(4)]
    assert ge == sorted(ge, reverse=True)


def test_every_tile_is_valid_glb(comp):
    for tid, t in comp.tiles.items():
        r = validate_tile(t.data)
        assert not r["problems"], (tid, r["problems"])
        doc = r["doc"]
        lk = doc["asset"]["extras"]["lk"]
        assert lk["tile_id"] == tid and lk["format"] == "lk.tile.v1"
        # advertised bounds contain every position
        lo, hi = np.array(lk["bounds_min_m"]) - 1e-3, np.array(lk["bounds_max_m"]) + 1e-3
        _, binary = parse_glb(t.data)
        for m in doc["meshes"]:
            for p in m["primitives"]:
                pos = read_accessor(doc, binary, p["attributes"]["POSITION"])
                if "EXT_mesh_gpu_instancing" not in str(doc["nodes"]):
                    assert (pos >= lo).all() and (pos <= hi).all(), tid


def test_feature_ids_are_stable_across_lods_and_resolve(topo, comp):
    fmap = comp.partition  # noqa: F841 (partition reachable)
    import json
    feats = json.loads(comp.blobs[comp.manifest["features"]["sha256"]][0])["features"]
    assert feats["rack_a1"]["entity_id"] == "rack_a1" and feats["rack_a1#door"]["entity_id"] == "rack_a1"
    assert feats["sup.p_01.0"]["entity_id"] == "p_01"
    seen = {}
    for tid, t in comp.tiles.items():
        doc, _ = parse_glb(t.data)
        table = doc["asset"]["extras"]["lk"]["feature_table"]
        assert len(table) == len(set(table))
        for f in table:
            assert f in feats, (tid, f)
            seen.setdefault(feats[f]["entity_id"], set()).add(t.lod)
    # a rack appears at LOD0 (instanced), LOD1 (row mesh) and LOD2 (rack detail) under the same entity id
    assert {0, 1, 2} <= seen["rack_a1"]
    assert {1, 2, 3} <= seen["p_hs_a"] and 0 in seen["p_hs_a"]


def test_pipe_arclength_attribute_matches_edge_length(topo, comp):
    doc, binary = parse_glb(comp.tiles["ROW-01@L1"].data)
    e = next(e for e in topo["edges"] if e["id"] == "p_hs_a")
    table = doc["asset"]["extras"]["lk"]["feature_table"]
    best = 0.0
    for m in doc["meshes"]:
        for p in m["primitives"]:
            if "_S_M" in p["attributes"]:
                s = read_accessor(doc, binary, p["attributes"]["_S_M"])
                f = read_accessor(doc, binary, p["attributes"]["_FEATURE_ID"])
                sel = s[f == table.index("p_hs_a")]
                if len(sel):
                    best = max(best, float(sel.max()))
    assert abs(best - e["length_m"]) < 0.05


def test_bore_normals_face_the_axis(comp):
    doc, binary = parse_glb(comp.tiles["PS-p_hs_a-01@L3"].data)
    p = doc["meshes"][0]["primitives"][0]
    pos, nrm = (read_accessor(doc, binary, p["attributes"][k]) for k in ("POSITION", "NORMAL"))
    axis_y, axis_z = 3.2, -8.45          # p_hs_a runs along x at (y=3.2, z=-8.45)
    radial = np.stack([np.zeros(len(pos)), pos[:, 1] - axis_y, pos[:, 2] - axis_z], axis=1)
    keep = np.linalg.norm(radial, axis=1) > 0.04   # skip the fillet start
    assert ((radial[keep] * nrm[keep]).sum(axis=1) < 0).mean() > 0.95


def test_l0_has_instancing_extension_and_zone_groups(comp):
    doc, _ = parse_glb(comp.tiles["SHELL@L0"].data)
    assert "EXT_mesh_gpu_instancing" in doc["extensionsUsed"]
    groups = {n["extras"]["lk"]["group"] for n in doc["nodes"]}
    z = comp.manifest["zones"]
    for zz in z:
        if "l0_group" in zz:
            assert zz["l0_group"] in groups, zz["zone_id"]


# ------------------------------------------------------------------ store
def test_store_keeps_old_layouts_and_evicts_lru(topo):
    svc = AssetService(max_layouts=2)
    a = svc.compiled_for(topo)
    moved = copy.deepcopy(topo)
    moved["facility"] = {**moved["facility"], "topology_hash": "deadbeef", "topology_version": "facility_layout_v6@1#deadbeef"}
    b = svc.compiled_for(moved)
    assert svc.find_rev(topo["facility"]["topology_version"]) is a and svc.find_rev("deadbeef") is b
    assert svc.compile_count == 2 and svc.compiled_for(topo) is a      # cache hit, no recompile
    some = a.manifest["tiles"][0]["sha256"]
    assert svc.blob(some) is not None
    third = copy.deepcopy(moved)
    third["facility"] = {**third["facility"], "topology_hash": "cafe0001", "topology_version": "facility_layout_v6@1#cafe0001"}
    svc.compiled_for(third)
    assert svc.find_rev("deadbeef") is None and svc.find_rev(topo["facility"]["topology_version"]) is a   # LRU: b (least recent) was evicted
    assert svc.blob(b.manifest["tiles"][0]["sha256"]) is None or b.manifest["tiles"][0]["sha256"] in a.blobs   # evicted layouts drop their private blobs
    assert len(svc._compiled) == 2


# ------------------------------------------------------------------ REST
@pytest.fixture
def v6_client(client, engine, topo):
    engine._topo = copy.deepcopy(topo)
    return client


def test_manifest_endpoint_etag_and_cache_headers(v6_client, comp):
    r = v6_client.get("/api/v1/facilities/lab_01/render-manifest")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    mid = r.json()["manifest_id"]
    assert mid == comp.manifest_id and r.headers["etag"] == f'"{mid}"' and r.headers["cache-control"] == "no-cache"
    r304 = v6_client.get("/api/v1/facilities/lab_01/render-manifest", headers={"If-None-Match": f'"{mid}"'})
    assert r304.status_code == 304 and r304.content == b""
    pinned = v6_client.get(f"/api/v1/facilities/lab_01/render-manifest?rev={mid}")
    assert pinned.status_code == 200 and "immutable" in pinned.headers["cache-control"]
    byver = v6_client.get(f"/api/v1/render-manifest?rev={comp.manifest['topology_version'].replace('#', '%23')}")
    assert byver.status_code == 200 and byver.json()["manifest_id"] == mid
    assert v6_client.get("/api/v1/facilities/nope/render-manifest").status_code == 404
    assert v6_client.get("/api/v1/facilities/lab_01/render-manifest?rev=bogus").status_code == 404
    assert v6_client.get("/api/v1/facilities/lab_01/render-manifest?rev=%00%00").status_code in (404, 422)
    assert v6_client.get("/api/v1/runs/run_live/render-manifest").json()["manifest_id"] == mid


def test_manifest_requires_auth(app, v6_client):
    from fastapi.testclient import TestClient
    with TestClient(app) as anon:
        assert anon.get("/api/v1/facilities/lab_01/render-manifest").status_code in (401, 403)


def test_asset_endpoint_content_addressed_immutable(v6_client, comp):
    v6_client.get("/api/v1/facilities/lab_01/render-manifest")
    t = next(t for t in comp.manifest["tiles"] if t["tile_id"] == "ROW-01@L1")
    h = t["sha256"]
    for prefix in ("", "/api/v1"):
        r = v6_client.get(f"{prefix}/assets/sha256/{h}", headers={"Accept-Encoding": "identity", "Origin": "http://localhost:5173"})
        assert r.status_code == 200 and hashlib.sha256(r.content).hexdigest() == h
        assert r.headers["content-type"] == "model/gltf-binary" and r.headers["etag"] == f'"{h}"'
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
        assert r.headers["x-content-type-options"] == "nosniff"
    gz = v6_client.get(f"/assets/sha256/{h}", headers={"Accept-Encoding": "gzip"})
    assert gz.headers["content-encoding"] == "gzip" and hashlib.sha256(gz.content).hexdigest() == h   # client decodes -> identity bytes
    assert v6_client.get(f"/assets/sha256/{h}", headers={"If-None-Match": f'"{h}"'}).status_code == 304
    assert v6_client.head(f"/assets/sha256/{h}").status_code == 200
    assert v6_client.get("/assets/sha256/" + "0" * 64).status_code == 404
    assert v6_client.get("/assets/sha256/not-a-hash").status_code == 404
    assert v6_client.get("/assets/sha256/" + "G" * 64).status_code == 404


def test_old_layout_still_resolvable_after_topology_change(v6_client, engine, topo, comp):
    old_rev = comp.manifest_id
    v6_client.get("/api/v1/facilities/lab_01/render-manifest")
    new = copy.deepcopy(topo)
    new["facility"] = {**new["facility"], "topology_hash": "0badc0de", "topology_version": "facility_layout_v6@1#0badc0de"}
    engine._topo = new
    cur = v6_client.get("/api/v1/facilities/lab_01/render-manifest").json()
    assert cur["layout_hash"] == "0badc0de" and cur["manifest_id"] != old_rev
    old = v6_client.get(f"/api/v1/facilities/lab_01/render-manifest?rev={old_rev}")
    assert old.status_code == 200 and old.json()["layout_hash"] == topo["facility"]["topology_hash"]
    # and its tiles are still served
    h = old.json()["tiles"][0]["sha256"]
    assert v6_client.get(f"/assets/sha256/{h}").status_code == 200
