import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from './view';
import { siteModel } from './siteModel';
import { makeShader } from './tube';

/**
 * Per-room floor finish, drawn as a thin decal over the structural slab (so the slab keeps its lighting and shadows):
 *  - hall:        raised-access-floor tiles (0.6 m), perforated tiles only inside the cold aisle
 *  - mechanical / cdu: sealed concrete with saw-cut control joints and a painted pump-walkway border
 *  - corridor:    sealed concrete with a yellow robot / service lane
 *  - yard:        compacted gravel
 * Rooms come from /topology `site.rooms`; the cold-aisle band comes from the cabinet rows. One draw call per room.
 */
const VERT = /* glsl */ `varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`;
const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vP;
  uniform vec4 uRect;   // x0 z0 x1 z1
  uniform vec4 uCold[8]; // per cabinet row: z0 z1 of the supply-air strip in front of the cabinets (perforated tiles), x0 x1 in the pod
  uniform vec4 uHot[8];  // per cabinet row: z0 z1 of the exhaust strip behind the cabinets (sealed tiles)
  uniform vec2 uPodX;
  uniform float uKind;  // 0 hall, 1 plant, 2 corridor, 3 yard
  uniform float uAmt;
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main(){
    vec2 p = vP.xz;
    float edge = min(min(p.x - uRect.x, uRect.z - p.x), min(p.y - uRect.y, uRect.w - p.y));
    float ao = 1.0 - smoothstep(0.0, 1.8, edge);          // darken against walls: depth cue
    float px = fwidth(p.x) * 1.5;                          // metres per pixel: fade fine detail to its mean when it cannot be resolved
    vec3 col = vec3(0.0); float a = 0.0;
    if (uKind < 0.5) {
      vec2 t = p / 0.6; vec2 f = fract(t);
      vec2 id = floor(t);
      float seam = 1.0 - smoothstep(0.0, 0.03 + px * 1.6, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float tone = h21(id) * 0.035;
      col = vec3(0.165, 0.19, 0.225) + tone;               // sealed access-floor panel (painted steel / HPL)
      a = 0.86;
      float cold = 0.0; float hot = 0.0;
      for (int i = 0; i < 8; i++) {
        float inX = step(uPodX.x, p.x) * step(p.x, uPodX.y);
        cold = max(cold, inX * step(uCold[i].x, p.y) * step(p.y, uCold[i].y));
        hot = max(hot, inX * step(uHot[i].x, p.y) * step(p.y, uHot[i].y));
      }
      // hot side: a faintly warm sealed tile; cold side: perforated tiles on every second panel, cool grey
      col = mix(col, vec3(0.2, 0.18, 0.18), hot * 0.55);
      col = mix(col, vec3(0.15, 0.2, 0.26), cold * 0.7);
      vec2 d = fract(f * 7.0) - 0.5;
      float perf = cold * step(0.5, mod(id.x + id.y, 2.0));
      float hole = (1.0 - smoothstep(0.2, 0.34, length(d))) * step(0.1, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float holeAmt = mix(0.45, hole, 1.0 - smoothstep(0.012, 0.04, px));
      col = mix(col, vec3(0.025, 0.04, 0.05), perf * holeAmt * 0.92);
      col += vec3(0.04, 0.11, 0.15) * perf * holeAmt * uAmt * 0.3;
      col = mix(col, vec3(0.42, 0.47, 0.54), seam * 0.5);
    } else if (uKind < 2.5) {
      // sealed (epoxy) concrete: broad tone mottling, saw-cut control joints every 6 m, a painted pump walkway
      vec2 f = fract(p / 6.0);
      float joint = 1.0 - smoothstep(0.0, 0.004 + px * 0.06, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float m1 = h21(floor(p * 0.6)) * 0.012;
      float m2 = h21(floor(p * 3.0)) * 0.012;
      col = (uKind < 1.5 ? vec3(0.235, 0.25, 0.275) : vec3(0.27, 0.285, 0.31)) + m1 + m2;
      a = 0.86;
      col = mix(col, vec3(0.1, 0.11, 0.13), joint * 0.7);
      if (uKind < 1.5) {
        float b = smoothstep(1.32, 1.28, edge) * smoothstep(1.18, 1.22, edge);
        col = mix(col, vec3(0.62, 0.65, 0.7), b * 0.5);
      } else {
        float cz = 0.5 * (uRect.y + uRect.w);
        float dz = abs(p.y - cz);
        float lane = (smoothstep(1.05, 1.0, dz) * smoothstep(0.93, 0.98, dz));
        col = mix(col, vec3(0.62, 0.65, 0.7), lane * 0.55);
      }
    } else {
      float n = h21(floor(p * 9.0));
      col = vec3(0.13, 0.14, 0.155) + n * 0.07;
      a = 0.9;
    }
    col *= (1.0 - ao * 0.38);
    gl_FragColor = vec4(col, a);
  }
`;

export function RoomFloors() {
  const topo = useWorld((s) => s.topology);
  const items = useMemo(() => {
    if (!topo) return [];
    const m = siteModel(topo);
    return m.rooms.map((r) => {
      const pod = m.pods.find((p) => p.hallId === r.id);
      const kind = r.kind === 'hall' ? 0 : r.kind === 'yard' ? 3 : r.kind === 'corridor' ? 2 : 1;
      const [x0, z0, x1, z1] = r.rect;
      // per-row supply / exhaust strips: a road is bounded by the cold front of one row and the hot rear of its neighbour
      const cold: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));
      const hot: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));
      if (pod) {
        const d = pod.dims.d;
        const reach = Math.min(1.3, Math.max(0.6, (pod.roads[0]?.width ?? 2.6) / 2));
        pod.rows.slice(0, 8).forEach((row, i) => {
          const s = Math.cos(row.yaw) >= 0 ? 1 : -1; // +1: cabinet fronts face +z
          const f0 = row.z + s * d / 2;
          const f1 = row.z + s * (d / 2 + reach);
          const r0 = row.z - s * d / 2;
          const r1 = row.z - s * (d / 2 + reach);
          cold[i].set(Math.min(f0, f1), Math.max(f0, f1), 0, 0);
          hot[i].set(Math.min(r0, r1), Math.max(r0, r1), 0, 0);
        });
      }
      const u = { uRect: { value: new THREE.Vector4(x0, z0, x1, z1) }, uCold: { value: cold }, uHot: { value: hot }, uPodX: { value: new THREE.Vector2(pod?.x0 ?? 0, pod?.x1 ?? 0) }, uKind: { value: kind }, uAmt: { value: 0 } };
      const mat = makeShader(VERT, FRAG, u, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
      return { id: r.id, rect: r.rect, mat, u, ext: !!r.exterior };
    });
  }, [topo]);
  useEffect(() => () => items.forEach((i) => i.mat.dispose()), [items]);
  useFrame((_, dt) => {
    const v = useView.getState();
    // the cooling cutaway (x-ray) removes the floor finish so the pipework stands alone
    const on = v.layers.floor && v.mode !== 'pipe' && !v.xray;
    for (const it of items) it.mat.visible = on;
    void dt;
  });
  return (
    <group name="room-floors">
      {items.map((it) => {
        const [x0, z0, x1, z1] = it.rect;
        return (
          <mesh key={it.id} position={[(x0 + x1) / 2, it.ext ? -0.34 + 0.006 : 0.006, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1} material={it.mat}>
            <planeGeometry args={[x1 - x0, z1 - z0]} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ───────────── robot roads ───────────── */
const ROAD_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vP;
  uniform vec4 uRect; // x0 z0 x1 z1
  uniform float uKind; // 0 cold, 1 hot, 2 service
  uniform float uAmt;
  void main(){
    vec2 p = vP.xz;
    float cz = 0.5 * (uRect.y + uRect.w);
    float hw = 0.5 * (uRect.w - uRect.y);
    float dz = abs(p.y - cz);
    float pxm = fwidth(p.y) * 1.2;
    // the robot lane: a slightly darker rubberised strip, bounded by two thin off-white edge lines (no centre dashes, no colour: roads are not fluid)
    float edge = 1.0 - smoothstep(0.02 + pxm, 0.04 + pxm * 2.0, abs(dz - (hw - 0.22)));
    float body = 1.0 - smoothstep(hw - 0.24, hw - 0.2, dz);
    vec3 col = vec3(0.07, 0.08, 0.1);
    float a = body * 0.34;
    col = mix(col, vec3(0.72, 0.75, 0.8), edge);
    a = max(a, edge * 0.55);
    // end hatching where the lane meets a cross-aisle: three short bars at each end
    float ex = min(p.x - uRect.x, uRect.z - p.x);
    float bars = step(0.18, ex) * step(ex, 0.3) + step(0.5, ex) * step(ex, 0.62);
    a = max(a, bars * body * 0.22);
    // selected / hovered road: the UI accent tint over the whole lane (uAmt > 1)
    float pick = clamp((uAmt - 1.0) / 0.7, 0.0, 1.0);
    col = mix(col, vec3(0.36, 0.89, 0.82), pick * 0.75 * max(body * 0.6, edge));
    a = max(a, body * pick * 0.3);
    float fade = smoothstep(0.0, 0.5, ex);
    gl_FragColor = vec4(col, a * fade * min(uAmt, 1.0));
  }
`;

export function RoadDecals() {
  const topo = useWorld((s) => s.topology);
  const items = useMemo(() => {
    if (!topo) return [];
    return siteModel(topo).roads.map((r) => {
      const u = { uRect: { value: new THREE.Vector4(r.x0, r.z0, r.x1, r.z1) }, uKind: { value: r.kind === 'cold' ? 0 : r.kind === 'hot' ? 1 : 2 }, uAmt: { value: 1 } };
      const mat = makeShader(VERT, ROAD_FRAG, u, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false });
      return { r, mat, u };
    });
  }, [topo]);
  useEffect(() => () => items.forEach((i) => i.mat.dispose()), [items]);
  useFrame((_, dt) => {
    const v = useView.getState();
    const base = v.layers.roads && v.layers.floor && v.mode !== 'pipe' ? 1 : 0;
    for (const it of items) {
      const key = it.r.roadId ?? it.r.id;
      const picked = v.selectedId === `road:${key}` || v.hoverId === `road:${key}` || v.roadFocus === it.r.id;
      const anyFocus = !!v.roadFocus || (v.selectedId?.startsWith('road:') ?? false);
      const on = base * (picked ? 1.7 : anyFocus ? 0.45 : 1);
      it.u.uAmt.value += (on - it.u.uAmt.value) * (1 - Math.exp(-dt * 6));
      it.mat.visible = it.u.uAmt.value > 0.01;
    }
  });
  return (
    <group name="road-decals">
      {items.map(({ r, mat }) => (
        <mesh
          key={r.id}
          position={[(r.x0 + r.x1) / 2, 0.015, (r.z0 + r.z1) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={2}
          material={mat}
          onClick={(e) => {
            if (useView.getState().layers.roads) {
              e.stopPropagation();
              useView.getState().select(`road:${r.roadId ?? r.id}`);
            }
          }}
          onPointerOver={(e) => {
            if (useView.getState().layers.roads) {
              e.stopPropagation();
              useView.getState().hover(`road:${r.roadId ?? r.id}`);
            }
          }}
          onPointerOut={() => useView.getState().hover(null)}
        >
          <planeGeometry args={[r.x1 - r.x0, r.z1 - r.z0]} />
        </mesh>
      ))}
    </group>
  );
}

/* ───────────── rack row highlight (ROW-01..05) ───────────── */
/** A floor tint under a whole row (or road) while it, or one of its racks, is selected / hovered. One mesh per row / road, opacity eased in useFrame. */
export function RowHighlights() {
  const topo = useWorld((s) => s.topology);
  const items = useMemo(() => {
    if (!topo) return [];
    const m = siteModel(topo);
    const rows = m.pods.flatMap((p) => p.rows.map((r) => ({ sel: `row:${r.rowId ?? r.id}`, cx: (r.x0 + r.x1) / 2, cz: r.z, w: r.x1 - r.x0 + 0.6, d: m.rackDims.d + 0.5, racks: new Set(r.rackIds ?? []), color: '#5be3d0' })));
    const roads = m.roads.map((r) => ({ sel: `road:${r.roadId ?? r.id}`, cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, racks: new Set<string>(), color: '#2fd3e8' }));
    return [...rows, ...roads];
  }, [topo]);
  const mats = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  useFrame((_, dt) => {
    const v = useView.getState();
    items.forEach((r, i) => {
      const m = mats.current[i];
      if (!m) return;
      const on = v.selectedId === r.sel || v.hoverId === r.sel || (!!v.selectedId && r.racks.has(v.selectedId));
      const t = on && v.mode !== 'pipe' ? (v.selectedId === r.sel ? 0.38 : 0.2) : 0;
      m.opacity += (t - m.opacity) * (1 - Math.exp(-dt * 8));
      m.visible = m.opacity > 0.01;
    });
  });
  return (
    <group name="row-road-highlights">
      {items.map((r, i) => (
        <mesh key={r.sel} position={[r.cx, 0.03, r.cz]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3}>
          <planeGeometry args={[r.w, r.d]} />
          <meshBasicMaterial ref={(m) => void (mats.current[i] = m)} color={r.color} transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
