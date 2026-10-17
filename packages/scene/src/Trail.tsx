import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { isLiveWorldSource, samplePose, useWorld } from '@loopkeeper/core/store';
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

  if (!id) return null;
  return (
    <group name="robot-trail">
      <primitive object={trailObj} />
      {/* altitude stem to the floor + a floor ring: where it is above the slab, and how high */}
      <primitive object={stemObj} />
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
        <ringGeometry args={[0.18, 0.24, 28]} />
        <meshBasicMaterial color="#9fb4cc" transparent opacity={0.6} depthTest={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
