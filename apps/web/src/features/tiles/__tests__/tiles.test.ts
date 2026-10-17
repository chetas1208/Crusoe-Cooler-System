import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TileStreamingManager } from '../../../../../../packages/scene/src/tiles/manager';
import { AssetCache } from '../../../../../../packages/scene/src/tiles/cache';
import type { Manifest, ManifestTile } from '../../../../../../packages/scene/src/tiles/types';

/** a real, minimal GLB (one named group with one triangle mesh) built in memory: no fixtures on disk, no network */
function glb(groupName: string, mat = 'lk.rack', table: string[] = ['rack_a1']): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const fid = new Uint16Array([0, 0, 0, 0]);
  const bin = new Uint8Array(pos.byteLength + 8);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(fid.buffer), pos.byteLength);
  const json = {
    asset: { version: '2.0', extras: { lk: { feature_table: table } } },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: groupName, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _FEATURE_ID: 1 }, material: 0 }] }],
    materials: [{ name: mat }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    buffers: [{ byteLength: bin.byteLength }],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jp = new Uint8Array(Math.ceil(js.length / 4) * 4).fill(0x20);
  jp.set(js);
  js = jp;
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

const tile = (id: string, zone: string, lod: number, refine: string, b: [number, number, number, number, number, number]): ManifestTile => ({
  tile_id: id, zone_id: zone, lod, sha256: `sha_${id}`, url: `/assets/sha256/sha_${id}`, bytes: 400, bytes_gzip: 300,
  bounds_min_m: [b[0], b[1], b[2]], bounds_max_m: [b[3], b[4], b[5]], geometric_error_m: 0.25, refine, triangles: 1,
});
const manifest = (): Manifest => ({
  manifest_id: 'm1', manifest_version: 'lk.render-manifest/1', topology_version: 'v', layout_hash: 'h',
  levels: [{ lod: 0, name: 'shell', geometric_error_m: 1 }, { lod: 1, name: 'zone', geometric_error_m: 0.25 }, { lod: 2, name: 'detail', geometric_error_m: 0.05 }],
  zones: [
    { zone_id: 'SHELL', kind: 'shell', bounds_min_m: [-50, 0, -50], bounds_max_m: [50, 6, 50], parent: null, neighbors: [], lods: { '0': 'SHELL@L0' } },
    { zone_id: 'ROW-01', kind: 'row', bounds_min_m: [0, 0, 0], bounds_max_m: [10, 3, 2], parent: 'SHELL', neighbors: [], lods: { '1': 'ROW-01@L1', '2': 'ROW-01@L2' }, l0_group: 'ROW-01' },
    { zone_id: 'FAR', kind: 'row', bounds_min_m: [900, 0, 900], bounds_max_m: [910, 3, 902], parent: 'SHELL', neighbors: [], lods: { '1': 'FAR@L1' }, l0_group: 'FAR' },
  ],
  tiles: [
    tile('SHELL@L0', 'SHELL', 0, 'base', [-50, 0, -50, 50, 6, 50]),
    tile('ROW-01@L1', 'ROW-01', 1, 'replace_group', [0, 0, 0, 10, 3, 2]),
    tile('ROW-01@L2', 'ROW-01', 2, 'add', [0, 0, 0, 10, 3, 2]),
    tile('FAR@L1', 'FAR', 1, 'replace_group', [900, 0, 900, 910, 3, 902]),
  ],
  features: { url: '/assets/sha256/features', sha256: 'features', count: 1 },
  limits: {},
});

let calls: string[] = [];
let abortedUrls: string[] = [];
let hang: Set<string>;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = []; abortedUrls = []; hang = new Set();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/features')) return new Response(JSON.stringify({ features: { 'rack_a1#door': { entity_id: 'rack_a1' } } }), { status: 200 });
    if ([...hang].some((h) => url.includes(h))) {
      return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => { abortedUrls.push(url); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
    }
    const name = url.includes('SHELL') ? 'ROW-01|geometry' : url.includes('ROW-01@L1') ? 'ROW-01|geometry' : 'RACK|geometry';
    return new Response(glb(name), { status: 200 });
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
const settle = async (m: TileStreamingManager, c: THREE.PerspectiveCamera, ms = 200) => { for (let i = 0; i < 6; i++) { m.update(c, 900, null); await new Promise((r) => setTimeout(r, ms / 6)); } };

describe('TileStreamingManager', () => {
  it('loads LOD0 first and nothing finer until a zone is close enough to need it', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    expect(m.group.children.length).toBe(1);
    await settle(m, cam(300, 80, 300)); // far away: sse of the 0.25 m level is below the threshold
    expect(calls.filter((c) => c.includes('ROW-01@L1')).length).toBe(0);
    m.dispose();
  });
  it('close camera loads the zone LOD1 (visible zone) and never the far, off-screen zone', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    await settle(m, cam(5, 6, 12), 400);
    expect(m.stats.resident_by_lod[1]).toBe(1);
    expect(calls.some((c) => c.includes('sha_FAR@L1'))).toBe(false);
    m.dispose();
  });
  it('replace_group: the shell group of that zone is hidden only after its LOD1 is attached', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    const shellRoot = m.group.children[0];
    const g = () => shellRoot.children.find((c) => c.name.startsWith('ROW-01|'));
    expect(g()?.visible).toBe(true);
    await settle(m, cam(5, 6, 12), 400);
    expect(m.stats.resident_by_lod[1]).toBe(1);
    expect(g()?.visible).toBe(false);
    m.dispose();
  });
  it('aborts an in-flight request the viewer no longer wants, and keeps the lower LOD visible', async () => {
    hang.add('sha_ROW-01@L1');
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    const c = cam(5, 6, 12);
    m.update(c, 900, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.stats.inflight).toBeGreaterThanOrEqual(1);
    m.update(cam(400, 80, 400), 900, null); // looked away
    await new Promise((r) => setTimeout(r, 30));
    expect(abortedUrls.some((u) => u.includes('ROW-01@L1'))).toBe(true);
    expect(m.group.children[0].children.find((x) => x.name.startsWith('ROW-01|'))?.visible).toBe(true);
    m.dispose();
  });
  it('a decode failure leaves the lower LOD and backs off instead of retrying every frame', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => (url.includes('ROW-01@L1') ? new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }) : real(url, init))) as typeof fetch;
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    await settle(m, cam(5, 6, 12), 500);
    expect(m.stats.decode_failures).toBeGreaterThanOrEqual(1);
    expect(m.stats.resident_by_lod[1] ?? 0).toBe(0);
    const n = calls.filter((c) => c.includes('ROW-01@L1')).length;
    await settle(m, cam(5, 6, 12), 300);
    expect(calls.filter((c) => c.includes('ROW-01@L1')).length).toBe(n); // backoff
    m.dispose();
  });
  it('resolves a hit to the canonical entity id through the feature table', async () => {
    const m = new TileStreamingManager(manifest(), 'http://x');
    await m.start();
    await new Promise((r) => setTimeout(r, 30));
    const mesh = (() => { let f: THREE.Mesh | null = null; m.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && !f) f = o as THREE.Mesh; }); return f!; })();
    const id = m.entityAt({ object: mesh, face: { a: 0, b: 1, c: 2 } } as unknown as THREE.Intersection);
    expect(id).toBe('rack_a1');
    m.dispose();
  });
});

describe('AssetCache', () => {
  const t: ManifestTile = tile('A', 'Z', 1, 'add', [0, 0, 0, 1, 1, 1]);
  it('deduplicates concurrent requests for the same hash and serves repeats from memory', async () => {
    const c = new AssetCache('http://x');
    await Promise.all([c.fetchBytes(t), c.fetchBytes(t), c.fetchBytes(t)]);
    expect(calls.filter((u) => u.includes('sha_A')).length).toBe(1);
    await c.fetchBytes(t);
    expect(calls.filter((u) => u.includes('sha_A')).length).toBe(1);
    expect(c.hits).toBeGreaterThanOrEqual(1);
  });
  it('evicts least-recently-used unreferenced tiles over quota and disposes their geometry', async () => {
    const c = new AssetCache('http://x', { encodedBytes: 1 << 20, gpuBytes: 50 });
    const mk = async (id: string) => { const tl = tile(id, id, 1, 'add', [0, 0, 0, 1, 1, 1]); const d = await c.decode(tl, glb('G')); return d; };
    const a = await mk('a');
    const b = await mk('b');
    let disposed = 0;
    a.root.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.addEventListener('dispose', () => disposed++); });
    c.retain('sha_b');
    expect(c.gpuBytes).toBeGreaterThan(50);
    c.trim();
    expect(c.has('sha_a')).toBe(false); // LRU, unreferenced
    expect(c.has('sha_b')).toBe(true); // referenced tiles are never evicted
    expect(disposed).toBe(1);
    expect(c.evicted).toBe(1);
    void b;
  });
});
