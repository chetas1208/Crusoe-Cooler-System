# V7 render assets, manifest and stream interest management (Agent C)

Owner: `backend/src/loopkeeper/assets/**`, `backend/src/loopkeeper/api/manifest.py`, interest additions in `api/stream.py`.
Tests: `backend/tests/test_v7_assets.py`, `backend/tests/test_v7_stream_interest.py`. Probe: `python -m loopkeeper.assets.gpu_probe`.

Everything below is generated from the live V6 `/topology`; nothing is hand-authored, random or time-dependent. Same topology -> same bytes -> same sha256.

## 1. Zones (`assets/partition.py`)

`build_partition(topo)` -> zones with world bounds (m, `facility_world`: x east, y up, z south), parent, neighbours and ONE primary zone per entity.

| zone id | kind | from topology |
|---|---|---|
| `SHELL` | shell | facility bounds (floor, walls, columns) |
| `ROW-01..05` | row | rack AABBs + both headers + all rack drops (+ their valves/sensors/ports) |
| `ROAD-0n-W/E` | road | road z +- clear_width/2, x = the road's `sectors` (west/east cell); docks ride in the cell tile |
| `XA-W`, `XA-E` | cross_aisle | `cross_aisles[]` |
| `PLANT` | plant | CDU, pumps, FWS strainer, chiller (yard), context equipment, tool docks, FWS pipes `p_01..p_03` |
| `TRUNK-TCS` | trunk | TCS trunk/tee edges `p_10..p_24`, `strainer_02`, ports on them |
| `DOCK-or1..`, `DOCK-tool1/2` | dock | interest/selection region around each dock (`geometry_in_zone` = the road cell/plant that holds the mesh) |
| `RACK-A1..E8` | rack | one rack + its two drops + valve/sensor (LOD2 detail, parent = its row) |
| `SVC-<asset>` | service | OUTRIG service bays (strainers, pumps, CDU): equipment AABB + `service_xyz_m` +-0.8 m |
| `PS-<edge>-NN` | pipe | pipe-segment neighbourhood: robot-passable edges split into <= 4 m chunks along the filleted centerline; `meta.s_lo_m/s_hi_m` are in **edge.length_m coordinates (= `nav.s_m`)**; neighbours = previous/next chunk + chunks meeting at the same junction node |

Currently 149 zones. Zone-level selectable entities (`ROW-01`, `ROAD-01`, `XA-W`, `floor`) are registered like assets.

## 2. Tiles and LODs (`assets/compiler.py`)

Format: **glTF 2.0 binary (GLB)**, loads with stock three `GLTFLoader` (verified on three 0.186 in node: meshes, `EXT_mesh_gpu_instancing`, `_feature_id`). Compression: identity bytes are hashed; gzip (`mtime=0`, deterministic) is served via `Content-Encoding` when accepted. **Brotli and meshopt are NOT used**: neither encoder is installed here and the tiles are small enough that they are not needed (LOD0 gzip = 7.6 KB, whole 213-tile set = 0.67 MB gzip).

| LOD | tiles | content | geometric error |
|---|---|---|---|
| 0 | 1 (`SHELL@L0`, 55 KB / 7.6 KB gz) | floor, walls (+door lintels), columns, **instanced** racks/equipment/docks (unit box + `EXT_mesh_gpu_instancing`), **line** pipes (centerlines), route-corridor quads. One node group per zone (`node.extras.lk.group`) | 1.0 m |
| 1 | 17 (5 rows, 8 road cells, 2 XA, PLANT, TRUNK-TCS) | meshed pipes (6-12 radial, filleted, real diameters), rack bodies, valves, sensors, ports, dock pads, lane edge lines, strainer/ctx-equipment cylinders | 0.25 m |
| 2 | 121 (40 `RACK-*`, 74 `PS-*`, 7 `SVC-*`) | rack door/handle/vents/LED strip/plinth, valve stems+handwheels, flow-meter bodies/displays, drop flanges; pipe hangers (from `supports`), tee/elbow collars (from `fittings`), spool couplings at chunk joints (presentation convention, not an engineering datum); service-bay floor decal + leader line to the asset | 0.05 m |
| 3 | 74 (`PS-*@L3`) | pipe **bore** surface (inner radius `bore_m/2`, inward normals, 24 radial, 0.5 m rings, `_S_M`) for in-pipe / contact views | 0.01 m |

**Not produced (and why):** no per-robot meshes (robots are a dynamic layer from `robot.pose`), no LOD3 for rover contact zones or equipment internals (topology has no such geometry; inventing it would be a fake). `manifest.omitted` lists any absent LOD (empty today). If the topology lacks something a builder needs the compile fails closed (503) rather than emitting placeholder tiles.

### Refinement rules (important for the viewer)
* L0 -> L1 is **replace per zone**: when a zone's L1 is resident, hide the `SHELL@L0` node group named by `zone.l0_group` (same string as the zone id).
* L2 and L3 are **add-only**: they never duplicate a lower-LOD surface (details sit proud of the L1 surfaces, the bore is an inner surface), so they can be shown/hidden independently.
* Keep lower LODs visible while a higher one loads; `tile.geometric_error_m` feeds the screen-space-error test: `sse_px = err * viewport_h / (2 * dist * tan(fov/2))`.

### Per-vertex attributes / node metadata
* `_FEATURE_ID` (uint16, also as an instance attribute on instanced nodes) -> `asset.extras.lk.feature_table[i]` = **feature id**. Entity = `feature_id.split('#')[0]`, except supports (`sup.*`) and fittings which map to their pipe edge. `features` asset (`manifest.features.url`, JSON) has `features{fid: {entity_id, kind, zone_id}}` and `entities{id: {kind, zone_id}}`. Feature/entity ids come from topology ids only, so they are identical at every LOD (tested: `rack_a1` is in LOD0/1/2, `p_hs_a` in LOD0/1/2/3).
* `_S_M` (float32, pipe meshes) = metres along the pipe in `edge.length_m` coordinates (same as `nav.s_m`), for deposit/fouling shading.
* Materials are named `lk.*` (default colours only; tint by live state in the client).
* `asset.extras.lk`: `tile_id, zone_id, lod, refine, layout_hash, topology_version, bounds_min_m, bounds_max_m, feature_table`.

## 3. Manifest + asset endpoints (`api/manifest.py`, `assets/store.py`)

* `GET /api/v1/facilities/{id}/render-manifest[?rev=]` (also `/api/v1/render-manifest`, `/api/v1/runs/{run_id}/render-manifest` which uses **that run's recorded topology**, so old runs keep their layout's assets).
  `rev` = `topology_version` | `layout_hash` | `manifest_id` | `cache_key`; unknown -> 404 with `X-LK-Manifest-Id` of the current one. ETag = `manifest_id`; `Cache-Control: no-cache` (revalidate, 304) unless pinned with `rev=<manifest_id>` (then `immutable`). Auth: same read scope as `/topology`.
* `GET|HEAD /assets/sha256/{hash}` (mirrored under `/api/v1/assets/sha256/`): `Cache-Control: public, max-age=31536000, immutable`, strong ETag = hash, `Content-Type: model/gltf-binary` (tiles) or `application/json` (features), `nosniff`, CORP cross-origin, CORS via the API's allow-list, gzip by `Accept-Encoding`. No auth: the 256-bit hash is the capability and tiles only contain simulated-facility geometry. Registered **before** the SPA `/assets` static mount.
* Keys: `layout_hash` (topology_hash), `topology_version`, `topology_digest` (sha256 over everything the compiler reads), `MANIFEST_VERSION`, `manifest_id` (sha256 of the canonical manifest), `cache_key = layout_hash/digest16/manifest_version`. Client cache key: `manifest.cache_key + '/' + tile.sha256`.
* Server cache: LRU of 8 layouts (compiled lazily, ~0.6 s, in a worker thread); tiles of unchanged zones keep their hash across layouts. A layout evicted from memory is recompiled from its run's topology on the next manifest request.
* **Change event:** `asset.manifest_changed` over the stream (`payload.manifest_id, previous_manifest_id, layout_hash, topology_version, manifest_version, url`). Sent when the topology key changes while connected (polled every 2 s, version strings only) and right after a `subscribe` whose `manifest_id` differs from the server's. It carries `seq = last sent seq` and does not advance seq.
* Budgets (current): LOD0 7.6 KB gz (limit 3 MB), manifest 158 KB / 22 KB gz, 213 tiles, 2.8 MB raw / 0.67 MB gz total.

## 4. Stream interest management (`assets/interest.py`, `api/stream.py`)

Opt-in per connection. Without a `subscribe` frame the stream is byte-for-byte what it was.

```jsonc
// client -> server (after auth; up to 16 KB, other frames keep the 4 KB cap)
{"type":"subscribe","run_id":"run_live","visible_zone_ids":["ROW-01","ROAD-01-W","PS-p_hs_a-02"],
 "selected_entity_id":"OR-03","camera_mode":"overview|orbit|chase|pov|map|inspect|drive",
 "rate_budget": 80,                       // total robot.pose msgs/s, or {"total_hz":80,"selected_hz":20,"visible_hz":10,"background_hz":1}
 "manifest_id":"<held manifest>"}
// server -> client
{"type":"stream.interest","seq":<last sent>,"payload":{"accepted":true,"effective":{...,"intervals_s":{...}},"stats":{...},"unknown_zone_ids":[]}}
// or {"accepted":false,"code":"bad_zones|bad_camera_mode|bad_rate_budget|bad_selected|bad_manifest_id|run_mismatch","reason":"..."} (connection stays open, previous policy kept)
```
`{"type":"stream.stats"}` returns the same ack with counters. Re-send `subscribe` whenever the camera/selection changes (it replaces the policy).

* Tiers per robot: **selected** (<= 20 Hz, but the engine publishes poses at 10 Hz wall cadence, so effectively <= 10 Hz today), **visible** (robot inside any `visible_zone_ids` bounds +0.5 m, or a crawler whose `nav.segment_id/s_m` lies in a visible `PS-*` chunk; default 10 Hz), **background** (default 1 Hz; `background_hz: 0` = event-only).
* Event-driven passes (never throttled): the first pose of a robot on the connection, any `mode` or `nav.segment_id` change, and the moving -> stopped transition, so a robot's resting pose is never lost.
* Total budget: selected is served first, visible gets <= 85 % of the remainder (floor 0.5 Hz each), background the rest.
* Only `robot.pose` is ever elided. Snapshots, world.diff, incidents, missions, heartbeats, `robot.control`... always pass. The engine is not told anything: all 18 robots keep simulating with zero subscribers or a throttled one.
* **Seq / gaps:** wire seq stays strictly increasing. A throttled run of poses leaves a hole in seq; the next event carries `"elided": n`. Client rule: `gap = ev.seq > lastSeq + 1 + (ev.elided ?? 0)` (`packages/core/src/client/live.ts:99`). Server-side live-skip detection still triggers a fresh `snapshot` (and clears the pending `elided`); resume (`since_seq`) replays the full log through the same filter. Queues stay bounded: the engine subscription keeps its 5000-event cap (overflow closes the connection -> client resumes/snapshots), there is no extra per-connection buffer.
* Validation: <= 256 zone ids (<= 64 chars), known camera modes, numeric finite rates clamped to `selected 1..20, visible 0.5..20, background 0..5, total 1..400` Hz.

## 5. GPU / NVENC probe (`assets/gpu_probe.py`)

`cd backend && uv run python -m loopkeeper.assets.gpu_probe` -> `artifacts/perf/gpu_probe.json` (probe only; nothing is started or enabled).
Measured on this host: 2x RTX 3090 (driver 535.288.01, CUDA 12.2 driver API, 24 GB each, 0 active encoder sessions), `libnvidia-encode.so.1` loads and reports NVENC API 12.1, **but** the installed `ffmpeg` has no `*_nvenc` encoder (only libx264/libvpx/libaom software), no PyAV/aiortc, no GStreamer, no coturn/turnserver, no Xvfb/EGL tooling, no headless browser on the GPU.
Result line: `remote streaming gated: ...` (encoder binding, headless GPU renderer, WebRTC stack, TURN, local-renderer-first gate from V7 section 0, no measured latency win). Remote streaming is not implemented and is never auto-enabled.
