import * as THREE from 'three';
import { AssetCache, type DecodedTile } from './cache';
import type { Manifest, ManifestTile, ManifestZone, TileStats } from './types';

/**
 * Progressive tile streaming.
 *  - LOD0 (SHELL) is fetched first and never evicted; everything finer is added or replaces per zone.
 *  - Per zone, the wanted LOD comes from screen-space error: levelError[lod-1] projected at the zone's distance.
 *    Hysteresis: a resident tile is kept until its error falls below half the load threshold AND stays there for 1.5 s.
 *  - The lower LOD stays visible while a higher one loads (replace_group hides the L0 node group only after L1 is attached).
 *  - Requests are prioritised by error, run with bounded concurrency, and are aborted when no longer wanted.
 *  - A byte-budgeted prefetch pass looks ~1.2 s ahead along the camera velocity.
 */
export interface TuneOptions {
  /** px of geometric error above which a finer level is wanted */
  loadPx: number;
  concurrency: number;
  prefetchBytesPerSec: number;
}
export const TUNE: Record<'high' | 'medium' | 'low', TuneOptions> = {
  high: { loadPx: 10, concurrency: 5, prefetchBytesPerSec: 1_500_000 },
  medium: { loadPx: 16, concurrency: 4, prefetchBytesPerSec: 900_000 },
  low: { loadPx: 28, concurrency: 3, prefetchBytesPerSec: 300_000 },
};

const _box = new THREE.Box3();

interface Resident {
  dec: DecodedTile;
  attachedAt: number;
}

export class TileStreamingManager {
  group = new THREE.Group();
  cache: AssetCache;
  stats: TileStats;
  private zones = new Map<string, ManifestZone>();
  private byZoneLod = new Map<string, ManifestTile>();
  private levelErr: number[] = [];
  private resident = new Map<string, Resident>();
  private loading = new Map<string, AbortController>();
  private lowSince = new Map<string, number>();
  private failedUntil = new Map<string, number>();
  private wanted = new Map<string, { tile: ManifestTile; prio: number; prefetch: boolean }>();
  private shell: Resident | null = null;
  private tokens = 0;
  private lastTick = performance.now();
  featureEntity = new Map<string, string>();
  tune: TuneOptions = TUNE.medium;
  private disposed = false;

  constructor(public manifest: Manifest, base: string) {
    this.group.name = 'tiles';
    this.cache = new AssetCache(base);
    for (const l of manifest.levels) this.levelErr[l.lod] = l.geometric_error_m;
    for (const z of manifest.zones) this.zones.set(z.zone_id, z);
    for (const t of manifest.tiles) this.byZoneLod.set(`${t.zone_id}|${t.lod}`, t);
    this.stats = { manifest_id: manifest.manifest_id, resident_tiles: 0, resident_by_lod: {}, encoded_bytes: 0, decoded_gpu_bytes: 0, triangles_resident: 0, inflight: 0, queued: 0, fetched: 0, fetched_bytes: 0, aborted: 0, evicted: 0, decode_failures: 0, cache_hits: 0, state: 'ready', error: null };
  }

  setQuality(tier: 'high' | 'medium' | 'low') {
    this.tune = TUNE[tier];
    this.cache.quota = tier === 'low' ? { encodedBytes: 12 << 20, gpuBytes: 48 << 20 } : tier === 'medium' ? { encodedBytes: 24 << 20, gpuBytes: 96 << 20 } : { encodedBytes: 48 << 20, gpuBytes: 160 << 20 };
    this.cache.trim();
  }

  /** LOD0 first; features table in the background (picking works without it via the feature id prefix) */
  async start(signal?: AbortSignal) {
    const shellTile = this.manifest.tiles.find((t) => t.lod === 0);
    if (!shellTile) throw new Error('manifest has no LOD0 tile');
    const buf = await this.cache.fetchBytes(shellTile, signal);
    const dec = await this.cache.decode(shellTile, buf);
    if (this.disposed) return;
    this.attach(dec);
    this.shell = { dec, attachedAt: performance.now() };
    this.resident.set(shellTile.tile_id, this.shell);
    this.cache.retain(shellTile.sha256);
    void fetch(this.cache.base + this.manifest.features.url, { signal, credentials: 'omit' })
      .then((r) => r.json())
      .then((j: { features?: Record<string, { entity_id: string }> }) => {
        for (const [fid, v] of Object.entries(j.features ?? {})) this.featureEntity.set(fid, v.entity_id);
      })
      .catch(() => undefined);
  }

  /**
   * Tiles carry geometry only (the manifest says: tint by state in the client). `colorOf(entityId)` returns a state colour
   * for entities that have one (racks by thermal margin); everything else keeps its tile material. Walls are made see-through
   * once, so the hall interior stays readable. Cheap: instanced racks get an instance colour, meshes a vertex colour.
   */
  private tinted = new Map<string, string>();
  tint(colorOf: (entityId: string) => THREE.Color | null) {
    const c = new THREE.Color();
    for (const r of this.resident.values()) {
      r.dec.root.traverse((o) => {
        const m = o as THREE.Mesh;
        const mat = m.material as THREE.Material | undefined;
        if (!mat || !m.geometry) return;
        if (mat.name === 'lk.wall' || mat.name === 'lk.floor.wall') {
          if (!mat.transparent) {
            mat.transparent = true;
            (mat as THREE.MeshStandardMaterial).opacity = 0.14;
            mat.depthWrite = false;
            mat.needsUpdate = true;
          }
          return;
        }
        if (mat.name === 'lk.floor' && !o.userData.lkDark) {
          o.userData.lkDark = true;
          (mat as THREE.MeshStandardMaterial).color?.multiplyScalar(0.28);
          return;
        }
        if (mat.name !== 'lk.rack') return;
        const table = o.userData.lkTable as string[] | undefined;
        if (!table) return;
        const inst = m as THREE.InstancedMesh;
        const fa = m.geometry.getAttribute('_FEATURE_ID') ?? m.geometry.getAttribute('_feature_id');
        if (!fa) return;
        let sig = '';
        const n = inst.isInstancedMesh ? inst.count : fa.count;
        const cols: Array<THREE.Color | null> = [];
        for (let i = 0; i < n; i++) {
          const fid = table[fa.getX(i)];
          const ent = fid ? (this.featureEntity.get(fid) ?? fid.split('#')[0]) : '';
          const col = ent ? colorOf(ent) : null;
          cols.push(col);
          sig += col ? col.getHexString() : '-';
        }
        const key = `${r.dec.tile.tile_id}|${o.id}`;
        if (this.tinted.get(key) === sig) return;
        this.tinted.set(key, sig);
        if (inst.isInstancedMesh) {
          cols.forEach((col, i) => inst.setColorAt(i, col ?? c.set('#4a5260')));
          if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        } else {
          let ca = m.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
          if (!ca) {
            ca = new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3);
            m.geometry.setAttribute('color', ca);
            (mat as THREE.MeshStandardMaterial).vertexColors = true;
            mat.needsUpdate = true;
          }
          cols.forEach((col, i) => (col ? ca!.setXYZ(i, col.r, col.g, col.b) : ca!.setXYZ(i, 0.29, 0.32, 0.38)));
          ca.needsUpdate = true;
        }
      });
    }
  }

  private attach(dec: DecodedTile) {
    dec.root.traverse((o) => {
      o.userData.lkTable = dec.table;
      o.userData.lkTile = dec.tile.tile_id;
    });
    this.group.add(dec.root);
  }

  private setShellGroup(zone: ManifestZone | undefined, visible: boolean) {
    if (!zone?.l0_group || !this.shell) return;
    const prefix = `${zone.l0_group}|`;
    for (const c of this.shell.dec.root.children) if (c.name.startsWith(prefix)) c.visible = visible;
  }

  /** feature (vertex or instance) -> canonical entity id, stable across LODs */
  entityAt(hit: THREE.Intersection): string | null {
    const obj = hit.object as THREE.Mesh;
    const table: string[] | undefined = obj.userData.lkTable;
    if (!table) return null;
    const g = obj.geometry;
    let idx: number | undefined;
    if ((obj as THREE.InstancedMesh).isInstancedMesh && hit.instanceId !== undefined) {
      const a = g.getAttribute('_FEATURE_ID') ?? g.getAttribute('_feature_id');
      idx = a ? a.getX(hit.instanceId) : undefined;
    } else if (hit.face) {
      const a = g.getAttribute('_feature_id') ?? g.getAttribute('_FEATURE_ID');
      idx = a ? a.getX(hit.face.a) : undefined;
    }
    const fid = idx !== undefined ? table[idx] : undefined;
    if (!fid) return null;
    return this.featureEntity.get(fid) ?? fid.split('#')[0];
  }

  private distTo(z: ManifestZone, p: THREE.Vector3) {
    _box.min.set(...z.bounds_min_m);
    _box.max.set(...z.bounds_max_m);
    return Math.max(_box.distanceToPoint(p), 0.3);
  }

  update(camera: THREE.PerspectiveCamera, viewH: number, velocity: THREE.Vector3 | null) {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.5);
    this.lastTick = now;
    this.tokens = Math.min(this.tokens + this.tune.prefetchBytesPerSec * dt, this.tune.prefetchBytesPerSec * 2);
    const k = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const ahead = velocity && velocity.lengthSq() > 0.04 ? camera.position.clone().addScaledVector(velocity, 1.2) : null;
    this.wanted.clear();
    for (const z of this.zones.values()) {
      if (z.zone_id === 'SHELL') continue;
      _box.min.set(...z.bounds_min_m).addScalar(-1);
      _box.max.set(...z.bounds_max_m).addScalar(1);
      const visible = frustum.intersectsBox(_box);
      const d0 = this.distTo(z, camera.position);
      const d1 = ahead ? this.distTo(z, ahead) : d0;
      const lods = Object.keys(z.lods).map(Number).sort((a, b) => a - b);
      for (const lod of lods) {
        const tile = this.byZoneLod.get(`${z.zone_id}|${lod}`);
        if (!tile) continue;
        const have = this.resident.has(tile.tile_id);
        const thr = have ? this.tune.loadPx * 0.5 : this.tune.loadPx;
        const err = this.levelErr[lod - 1] ?? 1;
        const sse0 = (err * k) / d0;
        const sseA = (err * k) / d1;
        if (visible && sse0 > thr) this.wanted.set(tile.tile_id, { tile, prio: sse0, prefetch: false });
        else if (!visible || sse0 <= thr) {
          if (sseA > this.tune.loadPx && !this.wanted.has(tile.tile_id)) this.wanted.set(tile.tile_id, { tile, prio: sseA * 0.4, prefetch: true });
          else if (!have) break; // the finer levels of this zone are even less wanted
        }
      }
    }
    // unload what has stayed unwanted
    for (const [id, r] of this.resident) {
      if (r.dec.tile.lod === 0) continue;
      if (this.wanted.has(id)) {
        this.lowSince.delete(id);
        continue;
      }
      const since = this.lowSince.get(id) ?? now;
      this.lowSince.set(id, since);
      if (now - since > 1500) this.detach(id);
    }
    // abort loads nobody wants any more
    for (const [id, ctl] of this.loading) if (!this.wanted.has(id)) ctl.abort();
    // start the best pending loads
    const pending = [...this.wanted.values()].filter((w) => !this.resident.has(w.tile.tile_id) && !this.loading.has(w.tile.tile_id) && (this.failedUntil.get(w.tile.tile_id) ?? 0) < now).sort((a, b) => b.prio - a.prio);
    this.stats.queued = pending.length;
    for (const w of pending) {
      if (this.loading.size >= this.tune.concurrency) break;
      if (w.prefetch) {
        if (this.tokens < w.tile.bytes_gzip) continue;
        this.tokens -= w.tile.bytes_gzip;
      }
      void this.load(w.tile);
    }
    this.cache.trim();
    this.refreshStats();
  }

  /** zones currently wanted at a finer level than the shell (what the viewer is actually looking at) */
  visibleZones(): string[] {
    return [...new Set([...this.wanted.values()].filter((w) => !w.prefetch).map((w) => w.tile.zone_id))].sort();
  }

  private async load(tile: ManifestTile) {
    const ctl = new AbortController();
    this.loading.set(tile.tile_id, ctl);
    try {
      const buf = await this.cache.fetchBytes(tile, ctl.signal);
      if (ctl.signal.aborted || this.disposed) return;
      const dec = await this.cache.decode(tile, buf);
      if (ctl.signal.aborted || this.disposed || !this.wanted.has(tile.tile_id)) return; // keep the bytes cached, do not attach
      this.attach(dec);
      this.cache.retain(tile.sha256);
      this.resident.set(tile.tile_id, { dec, attachedAt: performance.now() });
      // the lower LOD stays up until this tile is in the scene; only now hide the group it replaces
      if (tile.refine === 'replace_group') this.setShellGroup(this.zones.get(tile.zone_id), false);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        this.failedUntil.set(tile.tile_id, performance.now() + 30_000); // decode/network failure: the lower LOD simply stays
        this.stats.error = (e as Error).message;
      }
    } finally {
      this.loading.delete(tile.tile_id);
    }
  }

  private detach(id: string) {
    const r = this.resident.get(id);
    if (!r || r.dec.tile.lod === 0) return;
    this.group.remove(r.dec.root);
    this.resident.delete(id);
    this.lowSince.delete(id);
    this.cache.release(r.dec.tile.sha256);
    if (r.dec.tile.refine === 'replace_group') this.setShellGroup(this.zones.get(r.dec.tile.zone_id), true);
    this.cache.drop(r.dec.tile.sha256);
  }

  private refreshStats() {
    const by: Record<number, number> = {};
    let tris = 0;
    for (const r of this.resident.values()) {
      by[r.dec.tile.lod] = (by[r.dec.tile.lod] ?? 0) + 1;
      tris += r.dec.triangles;
    }
    Object.assign(this.stats, {
      resident_tiles: this.resident.size,
      resident_by_lod: by,
      triangles_resident: tris,
      inflight: this.loading.size,
      encoded_bytes: this.cache.encodedBytes,
      decoded_gpu_bytes: this.cache.gpuBytes,
      fetched: this.cache.fetched,
      fetched_bytes: this.cache.fetchedBytes,
      aborted: this.cache.aborted,
      evicted: this.cache.evicted,
      decode_failures: this.cache.decodeFailures,
      cache_hits: this.cache.hits,
    });
  }

  dispose() {
    this.disposed = true;
    for (const ctl of this.loading.values()) ctl.abort();
    this.group.clear();
    this.cache.clear();
    this.resident.clear();
  }
}

