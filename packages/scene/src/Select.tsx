import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { C } from './theme';
import { useView } from './view';

/** CAD-style corner brackets around an entity's bounding volume. */
export function Brackets({ size, id, offset = [0, 0, 0] as [number, number, number] }: { size: [number, number, number]; id: string; offset?: [number, number, number] }) {
  const mat = useRef<THREE.LineBasicMaterial>(null);
  const geo = useMemo(() => {
    const [w, h, d] = size.map((x) => x / 2);
    const L = Math.min(w, h, d) * 0.55 + 0.12;
    const pts: number[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x = sx * w;
          const y = sy * h;
          const z = sz * d;
          pts.push(x, y, z, x - sx * L, y, z, x, y, z, x, y - sy * L, z, x, y, z, x, y, z - sz * L);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [size]);
  useEffect(() => () => geo.dispose(), [geo]);
  const cur = useRef(0);
  useFrame((state, dt) => {
    const v = useView.getState();
    const t = v.selectedId === id ? 1 : v.hoverId === id ? 0.45 : 0;
    cur.current += (t - cur.current) * (1 - Math.exp(-dt * 12));
    if (mat.current) {
      mat.current.opacity = cur.current * (v.selectedId === id ? 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * 3.5) : 1);
      mat.current.visible = cur.current > 0.02;
      mat.current.color.set(v.selectedId === id ? C.accent : '#ffffff');
    }
  });
  return (
    <lineSegments geometry={geo} position={offset} renderOrder={10}>
      <lineBasicMaterial ref={mat} transparent opacity={0} depthTest={false} toneMapped={false} />
    </lineSegments>
  );
}

// `size` / `offset` are kept for call-site compatibility; hover/selection brackets are drawn once by <AssetBrackets/> (AssetInstances.tsx)
export function Selectable({ id, children, position, rotation }: { id: string; size?: [number, number, number]; offset?: [number, number, number]; children: ReactNode; position?: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group
      position={position}
      rotation={rotation}
      onPointerOver={(e) => {
        e.stopPropagation();
        useView.getState().hover(id);
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        useView.getState().hover(null);
        if (typeof document !== 'undefined') document.body.style.cursor = '';
      }}
      onClick={(e) => {
        e.stopPropagation();
        useView.getState().select(id);
      }}
    >
      {children}
    </group>
  );
}
