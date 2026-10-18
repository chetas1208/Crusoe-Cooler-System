import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { isLiveWorldSource, samplePose, useWorld } from '@loopkeeper/core/store';
import { navActions, navLinkLive, useNav, type GraphNode } from '@loopkeeper/core/control';
import type { Vec3 } from '@loopkeeper/core/contracts';
import { C } from './theme';
import { useView } from './view';
import { useMapCamera } from './mapCamera';

const MAX_PTS = 900;
const MIN_STEP = 0.12; // m between recorded points (decimation)
const JUMP = 6; // m: a bigger step means a seek/teleport in the source, so the old trail no longer applies

/**
 * True 3-D trail of the selected robot plus a floor/altitude indicator.
 * The history is built ONLY from the poses that are currently on screen (live stream, or the replay/branch buffer the
 * Execution tab selected), and it is cleared whenever the world source or the robot changes, or the pose jumps
 * (scrubbing). Live and replay poses are therefore never mixed. One draw call, no React state per frame.
 */
export function RobotTrail() {
  const selView = useView((s) => s.selectedId);
  const mapActive = useMapCamera((s) => s.active);
  const mapRobot = useMapCamera((s) => s.selectedRobotId);
  const robots = useWorld((s) => s.robots);
  const id = mapActive && robots[mapRobot] ? mapRobot : selView && robots[selView] ? selView : null;
  const cls = id ? robots[id]?.class : undefined;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PTS * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const stem = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  useEffect(
    () => () => {
      geo.dispose();
      stem.dispose();
    },
    [geo, stem],
  );
  const st = useRef({ n: 0, live: true, id: '' as string | null, last: new THREE.Vector3(), ring: new THREE.Mesh() });
  const ring = useRef<THREE.Mesh>(null);
  const trailMat = useMemo(() => new THREE.LineBasicMaterial({ color: C.inpipe, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }), []);
  const stemMat = useMemo(() => new THREE.LineBasicMaterial({ color: '#9fb4cc', transparent: true, opacity: 0.55, depthTest: false, toneMapped: false }), []);
  const trailObj = useMemo(() => {
    const l = new THREE.Line(geo, trailMat);
    l.renderOrder = 6;
    l.frustumCulled = false;
    return l;
  }, [geo, trailMat]);
  const stemObj = useMemo(() => {
    const l = new THREE.Line(stem, stemMat);
    l.renderOrder = 6;
    l.frustumCulled = false;
    return l;
  }, [stem, stemMat]);

  useFrame(() => {
    const s = st.current;
    const v = useView.getState();
    const live = isLiveWorldSource();
    if (s.id !== id || s.live !== live) {
      s.id = id;
      s.live = live;
      s.n = 0;
      geo.setDrawRange(0, 0);
    }
    const mc = useMapCamera.getState();
    const show = !!id && v.layers.robots && v.mode !== 'pipe' && !(mc.active && mc.cameraMode === 'first_person');
    for (const o of [trailObj, stemObj, ring.current]) if (o) o.visible = show;
    if (!show || !id) return;
    const sp = samplePose(id);
    if (!sp) return;
    const [x, y, z] = sp.pos;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    if (s.n > 0 && Math.hypot(x - s.last.x, y - s.last.y, z - s.last.z) > JUMP) {
      s.n = 0; // seek / jump in the source
    }
    if (s.n === 0 || Math.hypot(x - s.last.x, y - s.last.y, z - s.last.z) >= MIN_STEP) {
      if (s.n >= MAX_PTS) {
        // drop the oldest half (keeps the recent path, bounded memory)
        const a = pos.array as Float32Array;
        a.copyWithin(0, (MAX_PTS / 2) * 3, MAX_PTS * 3);
        s.n = MAX_PTS / 2;
      }
      pos.setXYZ(s.n, x, y, z);
      s.n++;
      s.last.set(x, y, z);
    }
    // live head: the line always ends exactly at the interpolated robot position
    const head = Math.min(s.n, MAX_PTS - 1);
    pos.setXYZ(head, x, y, z);
    pos.needsUpdate = true;
    geo.setDrawRange(0, head + 1);
    geo.computeBoundingSphere();
    const sa = stem.getAttribute('position') as THREE.BufferAttribute;
    sa.setXYZ(0, x, y, z);
    sa.setXYZ(1, x, 0.01, z);
    sa.needsUpdate = true;
    if (ring.current) ring.current.position.set(x, 0.012, z);
    const manual = useWorld.getState().robots[id]?.control?.authority === 'HUMAN';
    const col = manual ? C.accent : cls === 'outrig' ? C.outrig : C.inpipe;
    trailMat.color.set(col);
  });

  return (
    <>
      <RouteOverlay />
      {id && (
        <group name="robot-trail">
          <primitive object={trailObj} />
          {/* altitude stem to the floor + a floor ring: where it is above the slab, and how high */}
          <primitive object={stemObj} />
          <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
            <ringGeometry args={[0.18, 0.24, 28]} />
            <meshBasicMaterial color="#9fb4cc" transparent opacity={0.6} depthTest={false} toneMapped={false} />
          </mesh>
        </group>
      )}
    </>
  );
}

/* ───────────────────────────── V12 route + traffic overlay ───────────────────────────── */

const HALL_CENTER = new THREE.Vector3(7, 0, 0);
const ROUTE = { preview: '#38bdf8', reserved: '#22c55e', paused: '#f59e0b', stale: '#64748b', yield: '#f59e0b', blocked: '#ef4444', node: '#2fd3e8' } as const;

/** Text sprite (canvas texture): used for the "PREVIEW ONLY" tag; no extra dependency. */
export function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 48;
  const g = cv.getContext('2d');
  if (g) {
    g.fillStyle = 'rgba(8,12,18,0.82)';
    g.fillRect(0, 0, 256, 48);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(1, 1, 254, 46);
    g.fillStyle = color;
    g.font = '700 22px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 25);
  }
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
  sp.scale.set(1.6, 0.3, 1);
  sp.renderOrder = 12;
  return sp;
}

function nodePos(n: GraphNode, exterior: boolean): Vec3 | null {
  if (n.position_xyz_m) return n.position_xyz_m;
  if (typeof n.x === 'number' && typeof n.z === 'number') return [n.x, exterior ? 0.06 : 0, n.z];
  return null;
}

function lineObj(color: string, dashed: boolean): THREE.Line {
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.28, gapSize: 0.16, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
  const l = new THREE.Line(new THREE.BufferGeometry(), mat);
  l.renderOrder = 8;
  l.frustumCulled = false;
  return l;
}

function setLine(l: THREE.Line, pts: Vec3[] | null | undefined, lift: number) {
  const ok = !!pts && pts.length >= 2;
  l.visible = ok;
  if (!ok || !pts) return;
  l.geometry.dispose();
  l.geometry = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0], p[1] + lift, p[2])));
  if (l.material instanceof THREE.LineDashedMaterial) l.computeLineDistances();
}

/**
 * Route + traffic overlay for the Map tab. Draws ONLY what the server said:
 *  - preview: the planner's polyline, dashed, nothing reserved;
 *  - reserved: the committed route (the robot's own remaining `route_xyz_m` when the server publishes it, else the committed plan's
 *    polyline), solid; amber when paused by an operator override; grey and dimmed while the live stream is down;
 *  - traffic: yield (amber) / blocked (red) rings at the robot's streamed pose;
 *  - destination mode: clickable nodes of the graph that belongs to the selected robot's class.
 * Nothing here moves or extrapolates a robot.
 */
function RouteOverlay() {
  const phase = useNav((s) => s.phase);
  const robotId = useNav((s) => s.robotId);
  const plan = useNav((s) => s.plan);
  const graphs = useNav((s) => s.graphs);
  const traffic = useNav((s) => s.traffic);
  const robots = useWorld((s) => s.robots);
  const robot = robotId ? robots[robotId] : undefined;
  const exterior = robot ? robot.class !== 'inpipe' : true;
  const graph = exterior ? graphs.exterior : graphs.interior;
  const armed = phase === 'selecting' || phase === 'refused' || phase === 'planned' || phase === 'planning';

  const preview = useMemo(() => lineObj(ROUTE.preview, true), []);
  const reserved = useMemo(() => lineObj(ROUTE.reserved, false), []);
  const targetRing = useRef<THREE.Mesh>(null);
  const ringMats = useRef<Record<string, THREE.Mesh | null>>({});
  useEffect(
    () => () => {
      for (const l of [preview, reserved]) {
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
    },
    [preview, reserved],
  );

  // candidate destinations: exterior graph nodes (service / dock / junction / end) or pipe segment midpoints
  const cand = useMemo(() => {
    if (!graph) return [] as Array<{ id: string; p: Vec3; kind: string }>;
    const out: Array<{ id: string; p: Vec3; kind: string }> = [];
    // the planner accepts a pipe SEGMENT (or port) as an in-pipe target, never a bare junction node: crawlers get segment markers only
    for (const n of exterior ? graph.nodes : []) {
      const p = nodePos(n, exterior);
      if (!p) continue;
      const kind = n.kinds?.[0] ?? 'node';
      if (exterior && kind === 'door') continue;
      out.push({ id: n.id, p, kind });
    }
    if (!exterior) {
      for (const e of graph.edges) {
        const c = e.centerline_xyz_m;
        if (!c || c.length < 2) continue;
        const m = c[Math.floor(c.length / 2)];
        out.push({ id: e.id, p: m, kind: 'segment' });
      }
    }
    return out;
  }, [graph, exterior]);

  const inst = useRef<THREE.InstancedMesh>(null);
  // verification seam (only with ?e2e in the URL): screen position of a destination marker, so a browser test can click the real canvas
  const { camera, gl } = useThree();
  const candRef = useRef(cand);
  candRef.current = cand;
  useEffect(() => {
    if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('e2e')) return;
    const w = window as unknown as { __lkRouteScreen?: (id: string) => { x: number; y: number } | null };
    w.__lkRouteScreen = (id) => {
      if (id === '?') return { x: candRef.current.length, y: Object.keys(useNav.getState().graphs).length };
      const c = candRef.current.find((k) => k.id === id);
      if (!c) return null;
      const v = new THREE.Vector3(c.p[0], c.p[1] + (exterior ? 0.1 : 0), c.p[2]).project(camera);
      const r = gl.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
    return () => {
      delete w.__lkRouteScreen;
    };
  }, [camera, gl, exterior]);
  const [hover, setHover] = useState<number | null>(null);
  // markers grow with camera distance so they stay a usable click target from the overview (about 20 px) down to close-up
  const sizeF = useRef(1);
  const hoverRef = useRef<number | null>(null);
  hoverRef.current = hover;
  const writeInstances = useCallback(() => {
    const m = inst.current;
    if (!m) return;
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const f = sizeF.current;
    cand.forEach((c, i) => {
      d.position.set(c.p[0], c.p[1] + (exterior ? 0.1 : 0), c.p[2]);
      d.scale.setScalar((c.kind === 'service' ? 1.4 : c.kind === 'segment' ? 2.2 : 1.8) * f);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
      m.setColorAt(i, col.set(hoverRef.current === i ? '#ffffff' : c.kind === 'service' ? ROUTE.node : c.kind === 'segment' ? '#a78bfa' : '#fbbf24'));
    });
    m.count = cand.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [cand, exterior]);
  useEffect(() => {
    writeInstances();
  }, [writeInstances, hover, armed]);

  useFrame((state) => {
    const n = useNav.getState();
    if (inst.current && cand.length) {
      const dist = state.camera.position.distanceTo(HALL_CENTER);
      const f = Math.min(3.4, Math.max(1, dist / 16));
      if (Math.abs(f - sizeF.current) > 0.1) {
        sizeF.current = f;
        writeInstances();
      }
    }
    const live = navLinkLive();
    const r = n.robotId ? useWorld.getState().robots[n.robotId] : undefined;
    const showPlan = n.plan && (n.phase === 'planned' || n.phase === 'committing' || n.phase === 'refused' || n.phase === 'planning') ? n.plan : null;
    setLine(preview, showPlan?.waypoints, showPlan?.kind === 'interior' ? 0 : 0.08);
    const following = n.phase === 'following' || n.phase === 'paused';
    const path = following ? (r?.route_xyz_m && r.route_xyz_m.length >= 2 ? r.route_xyz_m : n.plan?.waypoints) : null;
    setLine(reserved, path, n.plan?.kind === 'interior' || r?.class === 'inpipe' ? 0 : 0.1);
    const mat = reserved.material as THREE.LineBasicMaterial;
    mat.color.set(!live ? ROUTE.stale : n.phase === 'paused' ? ROUTE.paused : ROUTE.reserved);
    mat.opacity = live ? 0.95 : 0.3;
    const tgt = showPlan?.waypoints ?? path;
    const ring = targetRing.current;
    if (ring) {
      const end = tgt && tgt.length ? tgt[tgt.length - 1] : null;
      ring.visible = !!end;
      if (end) {
        ring.position.set(end[0], end[1] + 0.07, end[2]);
        ring.scale.setScalar(1 + 0.12 * Math.sin(state.clock.elapsedTime * 4));
      }
    }
    for (const [rid, m] of Object.entries(ringMats.current)) {
      if (!m) continue;
      const sp = samplePose(rid);
      m.visible = !!sp && live;
      if (sp) m.position.set(sp.pos[0], sp.pos[1] + 0.05, sp.pos[2]);
    }
  });

  const marks = Object.values(traffic);
  return (
    <group name="route-overlay">
      <primitive object={preview} />
      <primitive object={reserved} />
      <mesh ref={targetRing} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9} visible={false}>
        <ringGeometry args={[0.28, 0.4, 32]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthTest={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {armed && cand.length > 0 && (
        <instancedMesh
          key={`dest-${cand.length}-${exterior ? 'x' : 'i'}`}
          ref={inst}
          args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, cand.length]}
          renderOrder={9}
          frustumCulled={false}
          onPointerMove={(e) => {
            e.stopPropagation();
            setHover(e.instanceId ?? null);
            if (typeof document !== 'undefined') document.body.style.cursor = 'crosshair';
          }}
          onPointerOut={() => {
            setHover(null);
            if (typeof document !== 'undefined') document.body.style.cursor = '';
          }}
          onClick={(e) => {
            e.stopPropagation();
            const c = e.instanceId !== undefined ? cand[e.instanceId] : undefined;
            if (c) void navActions.planTo(c.id);
          }}
        >
          <sphereGeometry args={[0.1, 14, 10]} />
          <meshBasicMaterial toneMapped={false} depthTest={false} transparent opacity={0.92} />
        </instancedMesh>
      )}
      {marks.map((m) => (
        <mesh
          key={m.robot_id}
          ref={(o) => {
            ringMats.current[m.robot_id] = o;
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={9}
        >
          <ringGeometry args={[0.55, 0.72, 32]} />
          <meshBasicMaterial color={m.kind === 'blocked' ? ROUTE.blocked : ROUTE.yield} transparent opacity={0.9} depthTest={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
