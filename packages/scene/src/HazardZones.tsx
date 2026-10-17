import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';

export interface HazardZone {
  hazard_id: string;
  kind: 'coolant_leak_puddle' | 'electrical_fire_smoke' | string;
  center_xyz: [number, number, number];
  radius_m: number;
  active: boolean;
  isolated?: boolean;
  repaired?: boolean;
  road_blocked?: boolean;
  heat_kw?: number;
  alarm?: boolean;
  description?: string;
}

export function HazardZones() {
  const hazards = useWorld((w) => (w as any)?.hazard_zones as HazardZone[] | undefined) || [];
  const activeHazards = hazards.filter((h) => h.active && !h.repaired);

  if (!activeHazards.length) return null;

  return (
    <group name="hazard-zones">
      {activeHazards.map((h) => (
        <HazardItem key={h.hazard_id} hazard={h} />
      ))}
    </group>
  );
}

function HazardItem({ hazard }: { hazard: HazardZone }) {
  const ringRef = useRef<THREE.Mesh>(null);
  const smokeRef = useRef<THREE.Mesh>(null);
  const isLeak = hazard.kind === 'coolant_leak_puddle';
  const radius = Math.max(0.6, hazard.radius_m || 1.2);
  const center = hazard.center_xyz || [0, 0, 0];

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (ringRef.current) {
      const pulse = 1.0 + Math.sin(t * 3.5) * 0.04;
      ringRef.current.scale.set(pulse, pulse, pulse);
    }
    if (smokeRef.current) {
      smokeRef.current.rotation.y = t * 0.2;
    }
  });

  if (isLeak) {
    return (
      <group position={[center[0], 0.015, center[2]]}>
        {/* Coolant liquid puddle body */}
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[radius, 32]} />
          <meshStandardMaterial
            color="#00d2ff"
            transparent
            opacity={hazard.isolated ? 0.45 : 0.75}
            roughness={0.05}
            metalness={0.8}
            depthWrite={false}
          />
        </mesh>

        {/* Hazard warning boundary ring */}
        <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
          <ringGeometry args={[radius * 0.95, radius * 1.05, 36]} />
          <meshBasicMaterial
            color={hazard.road_blocked ? '#ffaa00' : '#00e5ff'}
            transparent
            opacity={0.85}
            depthWrite={false}
          />
        </mesh>
      </group>
    );
  }

  // Electrical smoke / fire exclusion zone
  return (
    <group position={[center[0], 0.015, center[2]]}>
      {/* Exclusion perimeter ring */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius * 0.92, radius * 1.04, 36]} />
        <meshBasicMaterial color="#ff3b30" transparent opacity={0.9} depthWrite={false} />
      </mesh>

      {/* Inner warning disk */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius * 0.9, 32]} />
        <meshStandardMaterial color="#ff5500" transparent opacity={0.25} roughness={0.9} depthWrite={false} />
      </mesh>

      {/* Smoke plume proxy column */}
      <mesh ref={smokeRef} position={[0, 1.8, 0]}>
        <cylinderGeometry args={[radius * 0.8, radius * 0.3, 3.6, 16, 1, true]} />
        <meshStandardMaterial color="#3a3028" transparent opacity={0.4} roughness={1.0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
