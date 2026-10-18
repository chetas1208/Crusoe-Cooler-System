import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { activeTransport, useWorld } from '@loopkeeper/core/store';
import { authFetch } from '@loopkeeper/core/client';
import { useView } from '../view';
import { TileStreamingManager } from './manager';
import { STATUS_COLOR, marginColor } from '../theme';
import { useTileMode, type TileMode } from './mode';
import type { Manifest, TileStats } from './types';

declare global {
  interface Window {
    __lkTiles?: {
      stats: () => TileStats | null;
      manager: () => TileStreamingManager | null;
      mode: () => TileMode;
      state: () => TileState;
      /** manifest fetch attempts so far (retries included) and the last failure, for the verification scripts */
      attempts: () => { count: number; lastError: string | null };
    };
  }
}

export { tilesRequested } from './mode';

export type TileState = 'off' | 'loading' | 'ready' | 'failed';

/** retry schedule after the manifest or LOD0 failed (offline, 404, 5xx, topology mismatch): the procedural facility is drawn meanwhile */
export const RETRY_MS = [4_000, 15_000, 60_000, 180_000];

/** Streams the server render manifest's tiles into the scene. Reports its state so the procedural scene can take over on failure. */
export function TiledFacility({ onState }: { onState: (s: TileState) => void }) {
  const topoVersion = useWorld((s) => (s.topology ? s.topology.facility.topology_hash : ''));
  const facilityId = useWorld((s) => s.topology?.facility.id ?? 'lab_01');
  const [mgr, setMgr] = useState<TileStreamingManager | null>(null);
  const [retry, setRetry] = useState(0);
  const tier = useView((s) => s.quality);
  const { camera, size } = useThree();
  const acc = useRef(0);
  const prev = useRef(new THREE.Vector3());
  const vel = useRef(new THREE.Vector3());
  const tintTick = useRef(0);
  const col = useRef(new THREE.Color());
  const attempts = useRef({ count: 0, lastError: null as string | null });
  const stateRef = useRef<TileState>('off');
  const report = (s: TileState) => {
    stateRef.current = s;
    onState(s);
  };

  useEffect(() => {
    const t = activeTransport();
    const base = t?.info.kind === 'live' ? t.info.url?.replace(/\/$/, '') : undefined;
    if (!base || !topoVersion) {
      report('failed'); // embedded mock: no manifest exists, never fake one
      return;
    }
    const ctl = new AbortController();
    let m: TileStreamingManager | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    report('loading');
    attempts.current.count++;
    (async () => {
      try {
        const r = await authFetch(`${base}/api/v1/facilities/${encodeURIComponent(facilityId)}/render-manifest`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`render-manifest HTTP ${r.status}`);
        const manifest = (await r.json()) as Manifest;
        // a manifest for another layout than the one on screen must not be drawn over it
        if (manifest.layout_hash && !topoVersion.includes(manifest.layout_hash) && !manifest.topology_version.endsWith(topoVersion)) throw new Error(`manifest ${manifest.topology_version} does not match topology ${topoVersion}`);
        m = new TileStreamingManager(manifest, base);
        await m.start(ctl.signal);
        if (ctl.signal.aborted) return;
        setMgr(m);
        report('ready');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        m?.dispose();
        m = null;
        attempts.current.lastError = (e as Error).message;
        console.warn('tile streaming unavailable, using the procedural facility:', e);
        report('failed');
        const wait = RETRY_MS[Math.min(attempts.current.count - 1, RETRY_MS.length - 1)];
        timer = setTimeout(() => setRetry((n) => n + 1), wait);
      }
    })();
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
      m?.dispose();
      setMgr(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoVersion, facilityId, retry]);

  useEffect(() => {
    window.__lkTiles = {
      stats: () => mgrRef.current?.stats ?? null,
      manager: () => mgrRef.current,
      mode: () => useTileMode.getState().mode,
      state: () => stateRef.current,
      attempts: () => attempts.current,
    };
    return () => {
      delete window.__lkTiles;
    };
  }, []);
  const mgrRef = useRef<TileStreamingManager | null>(null);
  mgrRef.current = mgr;

  useEffect(() => mgr?.setQuality(tier), [mgr, tier]);

  useFrame((_, dt) => {
    if (!mgr) return;
    vel.current.copy(camera.position).sub(prev.current).divideScalar(Math.max(dt, 1e-3));
    prev.current.copy(camera.position);
    acc.current += dt;
    if (acc.current < 0.2) return;
    acc.current = 0;
    camera.updateMatrixWorld();
    mgr.update(camera as THREE.PerspectiveCamera, size.height, vel.current);
    if (++tintTick.current % 3 === 0) {
      const w = useWorld.getState();
      mgr.tint((id) => {
        const a = w.assets[id];
        if (!a || w.assetsById[id]?.type !== 'rack') return null;
        const lim = w.topology?.limits;
        return col.current.set(a.status === 'critical' || a.status === 'warning' || a.status === 'isolated' ? STATUS_COLOR[a.status] : marginColor(a.readings.margin_k ?? 40, lim?.margin_warn_k ?? 11, lim?.margin_crit_k ?? 5)).clone();
      });
    }
  });

  if (!mgr) return null;
  return (
    <primitive
      object={mgr.group}
      onPointerOver={(e: { intersections: THREE.Intersection[]; stopPropagation(): void }) => {
        const p = mgr.pick(e.intersections);
        if (p) {
          e.stopPropagation();
          useView.getState().hover(p.id);
        }
      }}
      onPointerOut={() => useView.getState().hover(null)}
      onClick={(e: { intersections: THREE.Intersection[]; stopPropagation(): void }) => {
        const p = mgr.pick(e.intersections);
        if (p) {
          e.stopPropagation();
          useView.getState().select(p.id);
        }
      }}
    />
  );
}
