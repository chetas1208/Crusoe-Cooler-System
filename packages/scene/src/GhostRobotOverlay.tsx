import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { usePreviewDrive } from '@loopkeeper/core/store';
import { makeLabelSprite } from './Trail';

/**
 * Renders a visually distinct holographic ghost proxy robot during non-destructive Preview Drive.
 * 
 * Invariants:
 * - Rendered ONLY when usePreviewDrive.getState().active is true.
 * - Zero mutations to the canonical simulation engine or database.
 * - Renders alongside the backend authoritative robot, highlighting the hypothetical ghost route.
 */
export function GhostRobotOverlay() {
  const active = usePreviewDrive((s) => s.active);
  const ghostPose = usePreviewDrive((s) => s.ghostPose);
  const initialPose = usePreviewDrive((s) => s.initialPose);
  const robotClass = usePreviewDrive((s) => s.robotClass);

  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  // Holographic chassis materials
  const ghostMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#00e5ff',
        emissive: '#00b0ff',
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.55,
        roughness: 0.2,
        metalness: 0.8,
        depthWrite: false,
      }),
    []
  );

  const wireMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#a5f3fc',
        wireframe: true,
        transparent: true,
        opacity: 0.85,
      }),
    []
  );

  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#22d3ee',
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    []
  );

  // always-visible tag: this body is a local what-if, the authoritative robot is the one the server reports
  const tag = useMemo(() => {
    const s = makeLabelSprite('PREVIEW ONLY · NOT SENT', '#22d3ee');
    s.position.set(0, 1.25, 0);
    return s;
  }, []);
  const chassisGeo = useMemo(() => new THREE.BoxGeometry(0.72, 0.38, 0.95), []);
  const mastGeo = useMemo(() => new THREE.CylinderGeometry(0.06, 0.06, 0.7, 16), []);
  const crawlerGeo = useMemo(() => new THREE.CylinderGeometry(0.08, 0.08, 0.45, 16), []);

  useFrame((state) => {
    if (!active || !ghostPose || !groupRef.current) return;

    const t = state.clock.elapsedTime;
    const pulse = 0.5 + 0.3 * Math.sin(t * 6);
    ghostMat.opacity = 0.45 + 0.2 * Math.sin(t * 4);
    ringMat.opacity = pulse;

    const p = ghostPose.position_xyz_m;
    const yaw = ghostPose.yaw_rad;

    groupRef.current.position.set(p[0], robotClass === 'inpipe' ? p[1] : 0.22, p[2]);
    groupRef.current.rotation.set(0, yaw, 0);

    if (ringRef.current) {
      ringRef.current.position.set(p[0], 0.02, p[2]);
      ringRef.current.rotation.set(-Math.PI / 2, 0, t);
    }
  });

  if (!active || !ghostPose) return null;

  const initP = initialPose?.position_xyz_m ?? ghostPose.position_xyz_m;
  const currP = ghostPose.position_xyz_m;
  const pathPoints = [
    new THREE.Vector3(initP[0], 0.03, initP[2]),
    new THREE.Vector3(currP[0], 0.03, currP[2]),
  ];
  const pathGeo = new THREE.BufferGeometry().setFromPoints(pathPoints);
  const pathMat = new THREE.LineDashedMaterial({
    color: '#38bdf8',
    dashSize: 0.2,
    gapSize: 0.1,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });
  const pathLine = new THREE.Line(pathGeo, pathMat);
  pathLine.computeLineDistances();

  return (
    <group name="ghost-preview-overlay">
      {/* Hypothetical path line from authoritative robot to ghost */}
      <primitive object={pathLine} />

      {/* Floor projection ring */}
      <mesh ref={ringRef} material={ringMat}>
        <ringGeometry args={[0.5, 0.62, 32]} />
      </mesh>

      {/* Ghost Robot Body */}
      <group ref={groupRef}>
        <primitive object={tag} />
        {robotClass === 'outrig' ? (
          <>
            <mesh geometry={chassisGeo} material={ghostMat} />
            <mesh geometry={chassisGeo} material={wireMat} />
            <mesh geometry={mastGeo} material={ghostMat} position={[0, 0.45, 0.15]} />
            <pointLight color="#00e5ff" intensity={1.5} distance={2.5} />
          </>
        ) : (
          <>
            <mesh geometry={crawlerGeo} material={ghostMat} rotation={[Math.PI / 2, 0, 0]} />
            <mesh geometry={crawlerGeo} material={wireMat} rotation={[Math.PI / 2, 0, 0]} />
            <pointLight color="#34d399" intensity={1.5} distance={1.8} />
          </>
        )}
      </group>
    </group>
  );
}
