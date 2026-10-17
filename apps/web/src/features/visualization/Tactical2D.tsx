import { useEffect, useRef } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import type { Asset, PipeEdge, Robot, Topology, Vec3 } from '@loopkeeper/core/contracts';
import { OVERVIEW_VIEW, fitCamera, overviewBoxes, useView } from '@loopkeeper/scene';
import './visualization.css';

/**
 * TACTICAL_2D: a plan view drawn with canvas 2D from /topology and the live robot poses.
 * - Nothing here uses three/WebGL, so it works with no GPU and costs one cheap redraw per store change (rAF-coalesced).
 * - Camera = the shared view store (`cam.target` / `cam.distance`), so presets, fly-to-selection and mode switches keep their framing.
 * - Pan / pinch / wheel are VIEW controls only. They never send a drive command; driving stays in the Map tab's lease-gated controls.
 * - Taps select entities through the same store as the 3D view (`useView.select`), so every inspector and command stays reachable.
 */
const COL = { tcs_supply: '#2fd3e8', tcs_return: '#ff9a3c', fws_supply: '#5b8dff', fws_return: '#d36bff' } as const;
const ROBOT = { inpipe: '#2fd3e8', outrig: '#ff9a3c' } as const;
const FOV_TAN = Math.tan((32 * Math.PI) / 360);

interface Layout {
  hall?: { x_min_m: number; x_max_m: number; z_min_m: number; z_max_m: number };
  rows?: Array<{ row_id: string; z_m: number; x_min_m: number; x_max_m: number }>;
  roads?: Array<{ road_id: string; z_m: number; x_min_m: number; x_max_m: number; clear_width_m: number }>;
  cross_aisles?: Array<{ id: string; x_min_m: number; x_max_m: number; z_min_m: number; z_max_m: number }>;
}

interface Frame {
  w: number;
  h: number;
  dpr: number;
  cx: number;
  cz: number;
  scale: number;
  insets: { left: number; right: number; top: number; bottom: number };
}

function pipeColor(e: PipeEdge): string {
  const k = `${e.loop}_${e.role}` as keyof typeof COL;
  return COL[k] ?? '#8a93a5';
}

function inRotRect(px: number, pz: number, a: Asset): boolean {
  const [x, , z] = a.position_xyz_m;
  const [sx, , sz] = a.size_m ?? [1, 1, 1];
  const c = Math.cos(-(a.yaw_rad ?? 0));
  const s = Math.sin(-(a.yaw_rad ?? 0));
  const dx = px - x;
  const dz = pz - z;
  return Math.abs(dx * c - dz * s) <= sx / 2 && Math.abs(dx * s + dz * c) <= sz / 2;
}

function segDist(px: number, pz: number, a: Vec3, b: Vec3): number {
  const vx = b[0] - a[0];
  const vz = b[2] - a[2];
  const l2 = vx * vx + vz * vz || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (pz - a[2]) * vz) / l2));
  return Math.hypot(px - (a[0] + vx * t), pz - (a[2] + vz * t));
}

export function Tactical2D() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const topo = useWorld((s) => s.topology);
  const topoRef = useRef<Topology | null>(topo);
  topoRef.current = topo;

  useEffect(() => {
    const cv = canvas.current!;
    const box = wrap.current!;
    const ctx = cv.getContext('2d')!;
    const frame: Frame = { w: 0, h: 0, dpr: 1, cx: 0, cz: 0, scale: 10, insets: { left: 0, right: 0, top: 0, bottom: 0 } };
    let dirty = true;
    let raf = 0;
    let disposed = false;
    const smooth = { x: NaN, z: NaN, d: NaN };
    let refCache = { key: '', dist: 40, fit: 10 };
    const mark = () => {
      dirty = true;
      if (!raf && !disposed) raf = requestAnimationFrame(tick);
    };

    // ---- size (ResizeObserver, coalesced into one rAF) ----
    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      frame.w = w;
      frame.h = h;
      frame.dpr = dpr;
      mark();
    };
    let roPending = false;
    const ro = new ResizeObserver(() => {
      if (roPending) return;
      roPending = true;
      requestAnimationFrame(() => {
        roPending = false;
        resize();
      });
    });
    ro.observe(box);
    resize();

    // ---- projection ----
    const sx = (x: number) => frame.w / 2 + (x - frame.cx) * frame.scale;
    const sz = (z: number) => frame.h / 2 + (z - frame.cz) * frame.scale;
    const wx = (px: number) => (px - frame.w / 2) / frame.scale + frame.cx;
    const wz = (py: number) => (py - frame.h / 2) / frame.scale + frame.cz;

    function updateCamera() {
      const v = useView.getState();
      const ins = document.documentElement.dataset.phone === '1' ? { left: 0, right: 0, top: 64, bottom: 0 } : v.insets;
      const freeW = Math.max(120, frame.w - ins.left - ins.right);
      const freeH = Math.max(120, frame.h - ins.top - ins.bottom);
      const tx = v.cam.target[0];
      const tz = v.cam.target[2];
      // zoom is relative to the "fit facility" overview: scale = (px/m that fits the hall in the free region) * (overview distance / camera distance),
      // so presets, fly-to-selection and pinch/wheel (all expressed as camera distance in the shared view store) mean the same thing in 2D.
      const topo2 = topoRef.current;
      let k = 10;
      if (topo2) {
        const key = `${frame.w}x${frame.h}|${ins.left},${ins.right},${ins.top},${ins.bottom}|${topo2.facility.topology_hash ?? ''}`;
        if (refCache.key !== key) {
          const boxes = overviewBoxes(topo2);
          const g = fitCamera({ boxes, width: frame.w, height: frame.h, insets: ins, ...OVERVIEW_VIEW });
          const bx = boxes[0];
          const fit = Math.min((freeW * 0.92) / (bx.max[0] - bx.min[0]), (freeH * 0.92) / (bx.max[2] - bx.min[2]));
          refCache = { key, dist: g.distance, fit };
        }
        k = refCache.fit * (refCache.dist / v.cam.distance);
      }
      // ease toward the goal (reduced motion: jump)
      if (Number.isNaN(smooth.x) || v.reducedMotion) {
        smooth.x = tx;
        smooth.z = tz;
        smooth.d = k;
      } else {
        smooth.x += (tx - smooth.x) * 0.22;
        smooth.z += (tz - smooth.z) * 0.22;
        smooth.d += (k - smooth.d) * 0.22;
      }
      const moving = Math.abs(tx - smooth.x) > 0.002 || Math.abs(tz - smooth.z) > 0.002 || Math.abs(k - smooth.d) > 0.002 * k;
      // shift so the target sits in the middle of the FREE region (panels cover the rest)
      const offX = (ins.left - ins.right) / 2;
      const offY = (ins.top - ins.bottom) / 2;
      frame.scale = smooth.d;
      frame.cx = smooth.x - offX / smooth.d;
      frame.cz = smooth.z - offY / smooth.d;
      frame.insets = ins;
      return moving;
    }

    function draw() {
      const t = topoRef.current;
      const { w, h, dpr } = frame;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!t) return;
      const world = useWorld.getState();
      const sel = useView.getState().selectedId;
      const lay = (t as unknown as { facility_layout_v6?: Layout }).facility_layout_v6;
      const fac = t.facility;
      const px = frame.scale;
      // floor
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(sx(fac.interior_min[0]), sz(fac.interior_min[2]), (fac.interior_max[0] - fac.interior_min[0]) * px, (fac.interior_max[2] - fac.interior_min[2]) * px);
      ctx.fill();
      ctx.stroke();
      // roads + cross aisles (robot corridors)
      ctx.fillStyle = 'rgba(244,201,76,0.07)';
      for (const r of lay?.roads ?? []) ctx.fillRect(sx(r.x_min_m), sz(r.z_m - r.clear_width_m / 2), (r.x_max_m - r.x_min_m) * px, r.clear_width_m * px);
      for (const a of lay?.cross_aisles ?? []) ctx.fillRect(sx(a.x_min_m), sz(a.z_min_m), (a.x_max_m - a.x_min_m) * px, (a.z_max_m - a.z_min_m) * px);
      // pipes
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const e of t.edges) {
        const pts = e.centerline_xyz_m;
        if (!pts || pts.length < 2) continue;
        const isSel = sel === e.id;
        ctx.strokeStyle = pipeColor(e);
        ctx.globalAlpha = isSel ? 1 : 0.8;
        ctx.lineWidth = Math.max(isSel ? 3 : 1.2, Math.min(5, (e.diameter_mm / 1000) * px * 0.8));
        ctx.beginPath();
        ctx.moveTo(sx(pts[0][0]), sz(pts[0][2]));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i][0]), sz(pts[i][2]));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // assets
      for (const a of t.assets) {
        const [x, , z] = a.position_xyz_m;
        const isSel = sel === a.id;
        if (a.type === 'rack' || a.type === 'cdu' || a.type === 'chiller' || a.type === 'pump' || a.type === 'dock') {
          const [bx, , bz] = a.size_m ?? [1, 1, 1];
          ctx.save();
          ctx.translate(sx(x), sz(z));
          ctx.rotate(a.yaw_rad ?? 0);
          ctx.fillStyle = a.type === 'rack' ? '#252b35' : a.type === 'dock' ? 'rgba(65,214,163,0.25)' : '#3a4352';
          ctx.strokeStyle = isSel ? '#5be3d0' : 'rgba(255,255,255,0.22)';
          ctx.lineWidth = isSel ? 2 : 1;
          ctx.beginPath();
          ctx.rect((-bx * px) / 2, (-bz * px) / 2, bx * px, bz * px);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        } else if (px > 16 || isSel) {
          ctx.fillStyle = a.type === 'valve' ? '#ff6b6b' : a.type === 'sensor' ? '#f4c94c' : '#9aa3b2';
          ctx.beginPath();
          ctx.arc(sx(x), sz(z), isSel ? 5 : 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // row labels
      if (px > 9) {
        ctx.fillStyle = 'rgba(233,236,241,0.55)';
        ctx.font = '600 10px Geist Variable, system-ui, sans-serif';
        ctx.textAlign = 'left';
        for (const r of lay?.rows ?? []) ctx.fillText(r.row_id, sx(r.x_min_m), sz(r.z_m) - 1.1 * px - 3);
      }
      // incidents
      const now = performance.now() / 600;
      for (const i of Object.values(world.incidents)) {
        if (i.closed_tick) continue;
        const p = i.anchor.position_xyz_m;
        ctx.strokeStyle = i.severity === 'critical' ? '#ff5d5d' : '#f4a73c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(p[0]), sz(p[2]), 9 + 3 * Math.sin(now), 0, Math.PI * 2);
        ctx.stroke();
      }
      // selected robot route
      const robots = Object.values(world.robots) as Robot[];
      const selRobot = sel ? world.robots[sel] : undefined;
      if (selRobot?.route_xyz_m && selRobot.route_xyz_m.length > 1) {
        ctx.strokeStyle = 'rgba(91,227,208,0.9)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx(selRobot.pose.position_xyz_m[0]), sz(selRobot.pose.position_xyz_m[2]));
        for (const p of selRobot.route_xyz_m) ctx.lineTo(sx(p[0]), sz(p[2]));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // robots (screen-space size so they stay tappable at any zoom)
      for (const r of robots) {
        const p = r.pose.position_xyz_m;
        const x = sx(p[0]);
        const y = sz(p[2]);
        const rad = r.class === 'outrig' ? 9 : 7;
        ctx.fillStyle = ROBOT[r.class as keyof typeof ROBOT] ?? '#9aa3b2';
        ctx.globalAlpha = r.mode === 'DOCKED' ? 0.7 : 1;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        const q = r.pose.quaternion_xyzw;
        const yaw = q ? 2 * Math.atan2(q[1], q[3]) : 0; // rotation about +y
        ctx.strokeStyle = '#0b0d11';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.sin(yaw) * rad, y + Math.cos(yaw) * rad);
        ctx.stroke();
        if (sel === r.id) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, rad + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (sel === r.id || px > 22) {
          ctx.fillStyle = '#e9ecf1';
          ctx.font = '600 10px Geist Mono Variable, ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(r.id, x, y - rad - 5);
        }
      }
      // north + scale bar
      ctx.fillStyle = 'rgba(233,236,241,0.7)';
      ctx.font = '600 10px Geist Variable, system-ui, sans-serif';
      ctx.textAlign = 'left';
      const bar = px >= 14 ? 5 : 10;
      const bx0 = 12 + frame.insets.left;
      const by0 = h - 14 - frame.insets.bottom;
      ctx.fillRect(bx0, by0, bar * px, 2);
      ctx.fillText(`${bar} m  ·  N ↑  ·  plan view`, bx0, by0 - 5);
    }

    function tick() {
      raf = 0;
      if (disposed) return;
      const moving = updateCamera();
      draw();
      dirty = false;
      if (moving || hasIncidents()) mark();
    }
    const hasIncidents = () => Object.values(useWorld.getState().incidents).some((i) => !i.closed_tick);

    // ---- input: pan / pinch / wheel (view only) + tap-to-select ----
    const pts = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let pinch0: { d: number; dist: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setTarget = (x: number, z: number) => {
      const f = useWorld.getState().topology?.facility;
      const lo = f?.interior_min ?? [-16, 0, -12];
      const hi = f?.interior_max ?? [28, 0, 12];
      useView.getState().setCam({ target: [Math.max(lo[0], Math.min(hi[0], x)), useView.getState().cam.target[1], Math.max(lo[2], Math.min(hi[2], z))] });
    };
    const onDown = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) down = { ...p, t: performance.now(), moved: false };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = { d: useView.getState().cam.distance, dist: Math.hypot(a.x - b.x, a.y - b.y) };
        if (down) down.moved = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size >= 2 && pinch0) {
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 8) useView.getState().setCam({ distance: Math.max(3, Math.min(120, pinch0.d * (pinch0.dist / dist))) });
        return;
      }
      if (down && !down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 6) down.moved = true;
      if (down?.moved) {
        const v = useView.getState();
        setTarget(v.cam.target[0] - (p.x - prev.x) / frame.scale, v.cam.target[2] - (p.y - prev.y) / frame.scale);
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = null;
      if (down && !down.moved && performance.now() - down.t < 450 && pts.size === 0) select(p.x, p.y);
      if (pts.size === 0) down = null;
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = useView.getState();
      v.setCam({ distance: Math.max(3, Math.min(120, v.cam.distance * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0013)))) });
    };

    function select(px: number, py: number) {
      const t = topoRef.current;
      const v = useView.getState();
      if (!t) return;
      const world = useWorld.getState();
      let best: { id: string; d: number } | null = null;
      for (const r of Object.values(world.robots) as Robot[]) {
        const d = Math.hypot(sx(r.pose.position_xyz_m[0]) - px, sz(r.pose.position_xyz_m[2]) - py);
        if (d < 22 && (!best || d < best.d)) best = { id: r.id, d };
      }
      if (!best) {
        const X = wx(px);
        const Z = wz(py);
        for (const a of t.assets) {
          if (a.type === 'rack' || a.type === 'cdu' || a.type === 'chiller' || a.type === 'pump' || a.type === 'dock') {
            if (inRotRect(X, Z, a)) best = { id: a.id, d: 0 };
          } else {
            const d = Math.hypot(sx(a.position_xyz_m[0]) - px, sz(a.position_xyz_m[2]) - py);
            if (d < 12 && (!best || d < best.d)) best = { id: a.id, d };
          }
        }
        if (!best) {
          for (const e of t.edges) {
            const pts2 = e.centerline_xyz_m;
            for (let i = 1; i < pts2.length; i++) {
              const d = segDist(X, Z, pts2[i - 1], pts2[i]) * frame.scale;
              if (d < 10 && (!best || d < best.d)) best = { id: e.id, d };
            }
          }
        }
      }
      v.select(best ? best.id : null);
    }

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    const offs = [useWorld.subscribe(mark), useView.subscribe(mark)];
    mark();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offs.forEach((o) => o());
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div className="tactical2d viewport" ref={wrap} data-testid="tactical-2d">
      <canvas ref={canvas} className="tactical2d__canvas" role="img" aria-label="Tactical plan view of the facility with live robot positions. Tap a robot, rack or pipe to select it." />
    </div>
  );
}
