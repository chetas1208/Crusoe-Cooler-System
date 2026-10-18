import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TileStreamingManager } from '../../../../../../packages/scene/src/tiles/manager';
import { DEFAULT_TILE_MODE, isSoftwareRenderer, parseTileMode, readTileMode, tilesWanted } from '../../../../../../packages/scene/src/tiles/mode';
import { batchStatic } from '../../../../../../packages/scene/src/Batch';
import { robotSignature } from '../../../../../../packages/scene/src/perf/ShadowGovernor';
import type { Manifest, ManifestTile } from '../../../../../../packages/scene/src/tiles/types';

/** minimal real GLB: one named node, one triangle, _FEATURE_ID, material name `mat` */
function glb(group: string, mat = 'lk.rack'): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const fid = new Uint16Array([0, 0, 0, 0]);
  const bin = new Uint8Array(pos.byteLength + 8);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(fid.buffer), pos.byteLength);
  const json = {
    asset: { version: '2.0', extras: { lk: { feature_table: ['rack_a1'] } } },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: group, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _FEATURE_ID: 1 }, material: 0 }] }], materials: [{ name: mat }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], buffers: [{ byteLength: bin.byteLength }],
  };
  const js0 = new TextEncoder().encode(JSON.stringify(json));
  const js = new Uint8Array(Math.ceil(js0.length / 4) * 4).fill(0x20);
  js.set(js0);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, js.length).set(js);
  const o = 20 + js.length;
  dv.setUint32(o, bin.length, true); dv.setUint32(o + 4, 0x004e4942, true);
  new Uint8Array(out, o + 8, bin.length).set(bin);
  return out;
}
const tile = (id: string, zone: string, lod: number, refine: string, b: number[]): ManifestTile => ({
  tile_id: id, zone_id: zone, lod, sha256: `sha_${id}`, url: `/assets/sha256/sha_${id}`, bytes: 400, bytes_gzip: 300,
  bounds_min_m: [b[0], b[1], b[2]], bounds_max_m: [b[3], b[4], b[5]], geometric_error_m: 0.25, refine, triangles: 1,
});
const manifest = (): Manifest => ({
  manifest_id: 'm1', manifest_version: 'v', topology_version: 'v', layout_hash: 'h',
  levels: [{ lod: 0, name: 's', geometric_error_m: 1 }, { lod: 1, name: 'z', geometric_error_m: 0.25 }],
  zones: [
    { zone_id: 'SHELL', kind: 'shell', bounds_min_m: [-50, 0, -50], bounds_max_m: [50, 6, 50], parent: null, neighbors: [], lods: { '0': 'SHELL@L0' } },
    { zone_id: 'ROW-01', kind: 'row', bounds_min_m: [0, 0, 0], bounds_max_m: [10, 3, 2], parent: 'SHELL', neighbors: [], lods: { '1': 'ROW-01@L1' }, l0_group: 'ROW-01' },
  ],
  tiles: [tile('SHELL@L0', 'SHELL', 0, 'base', [-50, 0, -50, 50, 6, 50]), tile('ROW-01@L1', 'ROW-01', 1, 'replace_group', [0, 0, 0, 10, 3, 2])],
  features: { url: '/assets/sha256/features', sha256: 'features', count: 1 }, limits: {},
});

let calls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/features')) return new Response(JSON.stringify({ features: { 'rack_a1#x': { entity_id: 'rack_a1', kind: 'rack' } } }), { status: 200 });
    return new Response(glb(url.includes('SHELL') ? 'ROW-01|geometry' : 'RACK|geometry'), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const cam = (x: number, y: number, z: number) => {
  const c = new THREE.PerspectiveCamera(32, 1.6, 0.1, 500);
  c.position.set(x, y, z);
  c.lookAt(5, 1, 1);
  c.updateMatrixWorld(true);
  return c;
};
const tick = async (m: TileStreamingManager, c: THREE.PerspectiveCamera, ms: number) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { m.update(c, 900, null); await new Promise((r) => setTimeout(r, 25)); }
};

describe('tile mode switch', () => {
  it('parses every spelling and ignores junk', () => {
    expect(['0', 'off', 'OFF', 'false'].map(parseTileMode)).toEqual(['off', 'off', 'off', 'off']);
    expect(['1', 'on', 'true'].map(parseTileMode)).toEqual(['on', 'on', 'on']);
    expect(parseTileMode('auto')).toBe('auto');
    expect(parseTileMode('maybe')).toBeNull();
    expect(parseTileMode(null)).toBeNull();
  });
  it('URL beats storage beats the default', () => {
    expect(readTileMode('?tiles=0', 'on')).toBe('off');
    expect(readTileMode('?x=1', 'on')).toBe('on');
    expect(readTileMode('', null)).toBe(DEFAULT_TILE_MODE);
    expect(readTileMode('?tiles=zzz', 'off')).toBe('off');
  });
  it('auto streams only on the low tier or a software rasteriser; on/off are absolute', () => {
    expect(tilesWanted('auto', 'high', false)).toBe(false);
    expect(tilesWanted('auto', 'medium', false)).toBe(false);
    expect(tilesWanted('auto', 'low', false)).toBe(true);
    expect(tilesWanted('auto', 'high', true)).toBe(true);
    expect(tilesWanted('on', 'high', false)).toBe(true);
    expect(tilesWanted('off', 'low', true)).toBe(false);
  });
  it('recognises CPU rasterisers by their renderer string', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (NVIDIA, Vulkan 1.3 (NVIDIA GeForce RTX 3090), NVIDIA)')).toBe(false);
  });
});

describe('picking', () => {
  const mesh = (matName: string, fid: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('_feature_id', new THREE.BufferAttribute(new Uint16Array([fid, fid, fid]), 1));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name: matName }));
    m.userData.lkTable = ['wall_n#a', 'rack_a1#door', 'valve_1#body'];
    return m;
  };
  const hit = (o: THREE.Object3D, distance: number) => ({ object: o, distance, point: new THREE.Vector3(), face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(), materialIndex: 0 } }) as unknown as THREE.Intersection;
  it('a rack behind the see-through hall wall is still the picked entity; a wall alone is returned as a last resort', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    const wall = mesh('lk.wall', 0);
    const rack = mesh('lk.rack', 1);
    expect(m.pick([hit(wall, 1), hit(rack, 5)])?.id).toBe('rack_a1');
    expect(m.pick([hit(wall, 1)])?.id).toBe('wall_n');
    expect(m.pick([])).toBeNull();
    // objects that are not tile meshes (no feature table) never become a tile pick
    const foreign = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    expect(m.pick([hit(foreign, 1), hit(rack, 2)])?.id).toBe('rack_a1');
    m.dispose();
  });
});

describe('residency: hysteresis, warm re-attach, LRU dispose', () => {
  it('keeps a tile through a short look-away, detaches it after 1.5 s, re-attaches it with no fetch and no re-decode, then LRU-disposes under a tiny quota', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    const near = cam(5, 6, 12);
    const far = cam(400, 80, 400);
    await tick(m, near, 500);
    expect(m.stats.resident_by_lod[1]).toBe(1);
    const fetchesAfterLoad = calls.filter((c) => c.includes('ROW-01@L1')).length;
    expect(fetchesAfterLoad).toBe(1);

    await tick(m, far, 700); // shorter than the 1.5 s hold: still resident
    expect(m.stats.resident_by_lod[1]).toBe(1);
    expect(m.stats.detached).toBe(0);

    await tick(m, far, 1200); // now past it
    expect(m.stats.resident_by_lod[1] ?? 0).toBe(0);
    expect(m.stats.detached).toBe(1);
    expect(m.cache.has('sha_ROW-01@L1')).toBe(true); // decoded tile kept (LRU), not disposed
    expect(m.cache.evicted).toBe(0);
    expect(m.group.children.length).toBe(1); // only the shell

    const decodedBefore = m.cache.decodedCount;
    await tick(m, near, 500); // come back
    expect(m.stats.resident_by_lod[1]).toBe(1);
    expect(calls.filter((c) => c.includes('ROW-01@L1')).length).toBe(fetchesAfterLoad); // no second request
    expect(m.cache.decodedCount).toBe(decodedBefore); // no second decode
    expect(m.events.some((e) => e.kind === 'cache_hit' && e.tile === 'ROW-01@L1')).toBe(true);

    await tick(m, far, 2000);
    expect(m.stats.resident_by_lod[1] ?? 0).toBe(0);
    let disposed = 0;
    m.cache.get('sha_ROW-01@L1')!.root.traverse((o) => (o as THREE.Mesh).geometry?.addEventListener('dispose', () => disposed++));
    m.cache.quota = { encodedBytes: 1 << 20, gpuBytes: 1 };
    m.cache.trim();
    expect(m.cache.has('sha_ROW-01@L1')).toBe(false);
    expect(disposed).toBe(1);
    expect(m.events.some((e) => e.kind === 'evict' && e.tile === 'ROW-01@L1')).toBe(true);
    expect(m.cache.has('sha_SHELL@L0')).toBe(true); // LOD0 is never evicted
    m.dispose();
  }, 15000);

  it('records decode time per tile', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    m.update(cam(5, 6, 12), 900, null);
    await tick(m, cam(5, 6, 12), 300);
    expect(m.stats.decoded_tiles).toBeGreaterThanOrEqual(2);
    expect(m.stats.decode_ms_total).toBeGreaterThan(0);
    expect(m.stats.decode_ms_max).toBeLessThanOrEqual(m.stats.decode_ms_total);
    expect(m.stats.lod0_ms).not.toBeNull();
    m.dispose();
  });
});

describe('static batching of animated groups', () => {
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c });
  function fan() {
    const root = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1), mat(0xaaaaaa));
    root.add(base);
    const spin = new THREE.Group();
    spin.userData.dyn = true;
    spin.position.set(2, 1, 0);
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.1), mat(0xe2e8f0));
      b.position.set(0.3, 0, 0);
      b.rotation.y = (i * Math.PI * 2) / 5;
      spin.add(b);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 12), mat(0x27384e));
    spin.add(hub);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    led.userData.dyn = true; // colour changes at run time: must stay its own mesh
    spin.add(led);
    root.add(spin);
    return { root, spin, led };
  }
  const visibleMeshes = (o: THREE.Object3D) => { let n = 0; o.traverse((x) => { if ((x as THREE.Mesh).isMesh && x.visible) n++; }); return n; };
  const worldBox = (o: THREE.Object3D, only: (m: THREE.Mesh) => boolean) => {
    const b = new THREE.Box3();
    o.updateMatrixWorld(true);
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh || !only(m)) return;
      // exact: transform every vertex (an AABB of a transformed AABB is looser than the box of the transformed vertices)
      const pos = m.geometry.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    });
    return b;
  };

  it('merges the static children of a spinning group per material, leaves the animated mesh alone, and follows the group when it turns', () => {
    const { root, spin, led } = fan();
    expect(visibleMeshes(root)).toBe(1 + 5 + 1 + 1);
    const before = worldBox(root, (m) => m.visible);
    const { meshes, hidden } = batchStatic(root);
    // base (1) + blades (1) + hub (1) + the dyn led (still itself)
    expect(visibleMeshes(root)).toBe(4);
    expect(meshes.length).toBe(3);
    expect(hidden.length).toBe(1 + 5 + 1);
    expect(led.visible).toBe(true);
    // merged geometry sits in the group's local space: same world bounds now ...
    const merged = (m: THREE.Mesh) => meshes.includes(m);
    const after = worldBox(root, (m) => merged(m) || m === led);
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-4);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-4);
    // ... and after the group rotates, the merged blades move with it exactly like the originals did
    spin.rotation.y = 1.1;
    const origAfterTurn = worldBox(root, (m) => hidden.includes(m));
    const mergedAfterTurn = worldBox(root, (m) => merged(m) && m.parent === spin);
    // blades + hub are the only merged meshes under the group: compare against the originals under the group
    const origUnderSpin = worldBox(root, (m) => hidden.includes(m) && m.parent === spin);
    expect(mergedAfterTurn.min.distanceTo(origUnderSpin.min)).toBeLessThan(1e-4);
    expect(mergedAfterTurn.max.distanceTo(origUnderSpin.max)).toBeLessThan(1e-4);
    void origAfterTurn;
    // triangle count is conserved
    const tris = (list: THREE.Mesh[]) => list.reduce((a, m) => a + (m.geometry.attributes.position.count / 3), 0);
    const origTris = hidden.reduce((a, m) => a + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    expect(Math.round(tris(meshes))).toBe(Math.round(origTris));
  });
});

describe('shadow governor signature', () => {
  it('changes when a robot moves 1 mm or turns, and not otherwise', () => {
    const r = { a: { pose: { position_xyz_m: [1, 0, 2] as [number, number, number], yaw_rad: 0.5 } }, b: { pose: { position_xyz_m: [3, 0, 4] as [number, number, number], yaw_rad: 0 } } };
    const s0 = robotSignature(r);
    expect(robotSignature(r)).toBe(s0);
    expect(robotSignature({ ...r, a: { pose: { ...r.a.pose, position_xyz_m: [1.0001, 0, 2] } } })).toBe(s0); // below the 1 mm quantum
    expect(robotSignature({ ...r, a: { pose: { ...r.a.pose, position_xyz_m: [1.002, 0, 2] } } })).not.toBe(s0);
    expect(robotSignature({ ...r, b: { pose: { ...r.b.pose, yaw_rad: 0.01 } } })).not.toBe(s0);
  });
});
