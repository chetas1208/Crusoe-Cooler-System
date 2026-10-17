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
  uniform vec4 uAisle;  // x0 z0 x1 z1 of the cold aisle (hall only), else zeros
  uniform float uKind;  // 0 hall, 1 plant, 2 corridor, 3 yard
  uniform float uAmt;
  float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  void main(){
    vec2 p = vP.xz;
    float edge = min(min(p.x - uRect.x, uRect.z - p.x), min(p.y - uRect.y, uRect.w - p.y));
    float ao = 1.0 - smoothstep(0.0, 1.6, edge) ;          // darken against walls: depth cue
    vec3 col = vec3(0.0); float a = 0.0;
    if (uKind < 0.5) {
      vec2 t = p / 0.6; vec2 f = fract(t);
      float seam = 1.0 - smoothstep(0.0, 0.035, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      vec2 id = floor(t);
      float tone = h21(id) * 0.04;
      col = vec3(0.20, 0.235, 0.285) + tone;               // access-floor panel
      a = 0.80;
      col = mix(col, vec3(0.50, 0.56, 0.64), seam * 0.65);
      bool inAisle = p.x > uAisle.x && p.x < uAisle.z && p.y > uAisle.y && p.y < uAisle.w;
      if (inAisle) {
        vec2 d = fract(p / 0.075) - 0.5;
        float hole = 1.0 - smoothstep(0.22, 0.32, length(d));
        col = mix(col, vec3(0.03, 0.07, 0.09), hole * 0.9);
        col += vec3(0.05, 0.30, 0.38) * hole * (0.35 + 0.65 * uAmt);
        col = mix(col, vec3(0.1, 0.55, 0.7), 0.10);
        a = 0.9;
      }
    } else if (uKind < 2.5) {
      vec2 f = fract(p / 6.0);
      float joint = 1.0 - smoothstep(0.0, 0.006, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
      float n = h21(floor(p * 3.0)) * 0.05;
      col = (uKind < 1.5 ? vec3(0.27, 0.285, 0.31) : vec3(0.30, 0.315, 0.34)) + n;
      a = 0.78;
      col = mix(col, vec3(0.12, 0.13, 0.15), joint * 0.8);
      if (uKind < 1.5) {
        // painted walkway border
        float b = smoothstep(1.35, 1.30, edge) * smoothstep(1.15, 1.20, edge);
        col = mix(col, vec3(0.91, 0.72, 0.23), b * 0.85);
      } else {
        // robot / service lane: two yellow edge lines along the corridor axis
        float cz = 0.5 * (uRect.y + uRect.w);
        float dz = abs(p.y - cz);
        float lane = (smoothstep(1.05, 1.0, dz) * smoothstep(0.93, 0.98, dz));
        float dash = step(0.5, fract(p.x / 1.6)) * (1.0 - smoothstep(0.0, 0.05, abs(dz)) ) ;
        col = mix(col, vec3(0.91, 0.72, 0.23), lane * 0.9);
        col = mix(col, vec3(0.18, 0.83, 0.91), step(0.5, fract(p.x / 1.0)) * (1.0 - smoothstep(0.04, 0.07, dz)) * 0.8);
      }
    } else {
      float n = h21(floor(p * 9.0));
      col = vec3(0.13, 0.14, 0.155) + n * 0.07;
      a = 0.85;
    }
    col *= (1.0 - ao * 0.35);
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
      const aisle = pod?.cold ? new THREE.Vector4(pod.x0, pod.cold.z0, pod.x1, pod.cold.z1) : new THREE.Vector4(0, 0, 0, 0);
      const u = { uRect: { value: new THREE.Vector4(x0, z0, x1, z1) }, uAisle: { value: aisle }, uKind: { value: kind }, uAmt: { value: 0 } };
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
    // painted edge lines just inside each rack face
    float edge = smoothstep(0.045, 0.0, abs(dz - (hw - 0.22)));
    // dashed centre line + flow chevrons along +x
    float dash = step(0.5, fract((p.x - uRect.x) / 1.2)) * smoothstep(0.045, 0.0, dz);
    float cx = fract((p.x - uRect.x) / 2.4) - 0.5;
    float chev = 0.0; // no direction marks on the floor: arrows are only drawn on pipes, from the solved flow sign
    vec3 base = uKind < 0.5 ? vec3(0.04, 0.2, 0.26) : uKind < 1.5 ? vec3(0.27, 0.14, 0.05) : vec3(0.12, 0.13, 0.15);
    vec3 col = base;
    float a = 0.34;
    col = mix(col, vec3(0.91, 0.72, 0.23), edge);
    a = max(a, edge * 0.95);
    col = mix(col, vec3(0.18, 0.83, 0.91), dash);
    a = max(a, dash * 0.9);
    col = mix(col, vec3(0.7, 0.8, 0.9), chev * 0.5);
    a = max(a, chev * 0.5);
    // soft fade at both ends
    float ex = smoothstep(0.0, 0.8, min(p.x - uRect.x, uRect.z - p.x));
    gl_FragColor = vec4(col, a * ex * uAmt);
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
