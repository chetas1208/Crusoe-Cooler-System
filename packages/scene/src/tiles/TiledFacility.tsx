import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { activeTransport, useWorld } from '@loopkeeper/core/store';
import { authFetch } from '@loopkeeper/core/client';
import { useView } from '../view';
import { TileStreamingManager } from './manager';
import { STATUS_COLOR, marginColor } from '../theme';
import type { Manifest, TileStats } from './types';

declare global {
  interface Window {
    __lkTiles?: { stats: () => TileStats | null; manager: () => TileStreamingManager | null };
  }
}

/** `?tiles=1` (or localStorage lk.tiles=1) turns the server-tile path on; the procedural facility is the default and the fallback. */
export const tilesRequested = (() => {
  try {
    return typeof location !== 'undefined' && (new URLSearchParams(location.search).get('tiles') === '1' || localStorage.getItem('lk.tiles') === '1');
  } catch {
    return false;
  }
})();

export type TileState = 'off' | 'loading' | 'ready' | 'failed';

/** Streams the server render manifest's tiles into the scene. Reports its state so the procedural scene can take over on failure. */
export function TiledFacility({ onState }: { onState: (s: TileState) => void }) {
  const topoVersion = useWorld((s) => (s.topology ? s.topology.facility.topology_hash : ''));
  const facilityId = useWorld((s) => s.topology?.facility.id ?? 'lab_01');
  const [mgr, setMgr] = useState<TileStreamingManager | null>(null);
  const tier = useView((s) => s.quality);
  const { camera, size } = useThree();
  const acc = useRef(0);
  const prev = useRef(new THREE.Vector3());
  const vel = useRef(new THREE.Vector3());
  const tintTick = useRef(0);
  const col = useRef(new THREE.Color());

  useEffect(() => {
    const t = activeTransport();
    const base = t?.info.kind === 'live' ? t.info.url?.replace(/\/$/, '') : undefined;
    if (!base || !topoVersion) {
      onState('failed'); // embedded mock: no manifest exists, never fake one
      return;
    }
    const ctl = new AbortController();
    let m: TileStreamingManager | null = null;
    onState('loading');
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
        onState('ready');
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        console.warn('tile streaming unavailable, using the procedural facility:', e);
        onState('failed');
      }
    })();
    window.__lkTiles = { stats: () => m?.stats ?? null, manager: () => m };
    return () => {
      ctl.abort();
      m?.dispose();
      setMgr(null);
    };
  }, [topoVersion, facilityId, onState]);

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
        const id = mgr.entityAt(e.intersections[0]);
        if (id) {
          e.stopPropagation();
          useView.getState().hover(id);
        }
      }}
      onPointerOut={() => useView.getState().hover(null)}
      onClick={(e: { intersections: THREE.Intersection[]; stopPropagation(): void }) => {
        const id = mgr.entityAt(e.intersections[0]);
        if (id) {
          e.stopPropagation();
          useView.getState().select(id);
        }
      }}
    />
  );
}
