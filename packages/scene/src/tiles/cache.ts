import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ManifestTile } from './types';

/**
 * Content-addressed asset cache. Keys are sha256 (the URL is immutable), so a hit can never be stale.
 * Three separate budgets: encoded bytes held in memory, decoded GPU-resident bytes (geometry + textures) and
 * in-flight requests. Eviction is LRU over entries nobody is using, with an explicit dispose of geometry,
 * materials and textures so the GPU memory is really returned.
 */
export interface DecodedTile {
  tile: ManifestTile;
  root: THREE.Group;
  table: string[];
  gpuBytes: number;
  triangles: number;
  last: number;
  refs: number;
}

export interface CacheQuota {
  encodedBytes: number;
  gpuBytes: number;
}

const LOADER = new GLTFLoader();

function sizeOf(root: THREE.Object3D) {
  let bytes = 0;
  let tris = 0;
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (g && !seen.has(g)) {
      seen.add(g);
      for (const a of Object.values(g.attributes)) bytes += (a as THREE.BufferAttribute).array.byteLength;
      if (g.index) bytes += g.index.array.byteLength;
      tris += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3 * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
    }
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) bytes += inst.instanceMatrix.array.byteLength;
  });
  return { bytes, tris: Math.round(tris) };
}

export function disposeTile(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = m.material ? ([] as THREE.Material[]).concat(m.material) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
    (o as THREE.InstancedMesh).dispose?.();
  });
}

export class AssetCache {
  private encoded = new Map<string, { buf: ArrayBuffer; last: number }>();
  private decoded = new Map<string, DecodedTile>();
  private inflight = new Map<string, { ctl: AbortController; p: Promise<ArrayBuffer> }>();
  encodedBytes = 0;
  gpuBytes = 0;
  evicted = 0;
  aborted = 0;
  fetched = 0;
  fetchedBytes = 0;
  decodeFailures = 0;
  hits = 0;
  constructor(public base: string, public quota: CacheQuota = { encodedBytes: 24 << 20, gpuBytes: 96 << 20 }) {}

  get inflightCount() {
    return this.inflight.size;
  }
  has(sha: string) {
    return this.decoded.has(sha);
  }
  get(sha: string) {
    const d = this.decoded.get(sha);
    if (d) d.last = performance.now();
    return d;
  }

  /** fetch immutable bytes; deduplicates concurrent requests; aborting cancels the network request */
  fetchBytes(tile: Pick<ManifestTile, 'sha256' | 'url' | 'bytes_gzip'>, external?: AbortSignal): Promise<ArrayBuffer> {
    const hit = this.encoded.get(tile.sha256);
    if (hit) {
      hit.last = performance.now();
      this.hits++;
      return Promise.resolve(hit.buf);
    }
    const run = this.inflight.get(tile.sha256);
    if (run) return run.p;
    const ctl = new AbortController();
    external?.addEventListener('abort', () => ctl.abort(), { once: true });
    const p = fetch(this.base + tile.url, { signal: ctl.signal, credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(`tile ${tile.sha256.slice(0, 8)} -> HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        this.fetched++;
        this.fetchedBytes += tile.bytes_gzip || buf.byteLength;
        this.encoded.set(tile.sha256, { buf, last: performance.now() });
        this.encodedBytes += buf.byteLength;
        this.trimEncoded();
        return buf;
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') this.aborted++;
        throw e;
      })
      .finally(() => this.inflight.delete(tile.sha256));
    this.inflight.set(tile.sha256, { ctl, p });
    return p;
  }

  cancel(sha: string) {
    this.inflight.get(sha)?.ctl.abort();
  }

  async decode(tile: ManifestTile, buf: ArrayBuffer): Promise<DecodedTile> {
    const hit = this.decoded.get(tile.sha256);
    if (hit) return hit;
    try {
      const gltf = await new Promise<{ scene: THREE.Group; asset?: { extras?: { lk?: { feature_table?: string[] } } } }>((res, rej) => LOADER.parse(buf, '', res as never, rej));
      const table = gltf.asset?.extras?.lk?.feature_table ?? [];
      const { bytes, tris } = sizeOf(gltf.scene);
      const d: DecodedTile = { tile, root: gltf.scene, table, gpuBytes: bytes, triangles: tris, last: performance.now(), refs: 0 };
      this.decoded.set(tile.sha256, d);
      this.gpuBytes += bytes;
      return d;
    } catch (e) {
      this.decodeFailures++;
      throw e;
    }
  }

  retain(sha: string) {
    const d = this.decoded.get(sha);
    if (d) d.refs++;
  }
  release(sha: string) {
    const d = this.decoded.get(sha);
    if (d && d.refs > 0) d.refs--;
  }

  /** evict least-recently-used unreferenced tiles until under quota; always disposes GPU resources */
  trim() {
    if (this.gpuBytes <= this.quota.gpuBytes) return;
    const order = [...this.decoded.values()].filter((d) => d.refs === 0 && d.tile.lod > 0).sort((a, b) => a.last - b.last);
    for (const d of order) {
      if (this.gpuBytes <= this.quota.gpuBytes * 0.85) break;
      this.drop(d.tile.sha256);
    }
  }
  drop(sha: string) {
    const d = this.decoded.get(sha);
    if (!d) return;
    disposeTile(d.root);
    this.decoded.delete(sha);
    this.gpuBytes -= d.gpuBytes;
    this.evicted++;
  }
  private trimEncoded() {
    if (this.encodedBytes <= this.quota.encodedBytes) return;
    const order = [...this.encoded.entries()].sort((a, b) => a[1].last - b[1].last);
    for (const [k, v] of order) {
      if (this.encodedBytes <= this.quota.encodedBytes * 0.85) break;
      this.encoded.delete(k);
      this.encodedBytes -= v.buf.byteLength;
    }
  }
  /** release everything (manifest change, context loss, quality drop) */
  clear() {
    for (const { ctl } of this.inflight.values()) ctl.abort();
    for (const k of [...this.decoded.keys()]) this.drop(k);
    this.encoded.clear();
    this.encodedBytes = 0;
  }
}
