import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { CameraRig } from './CameraRig';
import { RelevanceProvider } from './context';
import { Equipment } from './Equipment';
import { Facility } from './Facility';
import { HallDetail, PlantContext } from './HallDetail';
import { PipeInterior } from './PipeInterior';
import { Pipes } from './Pipes';
import { ShaderWarmup } from './Warmup';
import { TiledFacility, type TileState } from './tiles/TiledFacility';
import { isSoftwareRenderer, tilesWanted, useTileMode } from './tiles/mode';
import { ShadowGovernor } from './perf/ShadowGovernor';
import { PipeSupports } from './Supports';
import { RackBranches } from './Branches';
import { Racks } from './Racks';
import { Robots } from './Robots';
import { HazardZones } from './HazardZones';
import { useView } from './view';

function SceneLights({ shadows }: { shadows: boolean }) {
  const tier = useView((s) => s.quality);
  const { scene } = useThree();
  // every tier keeps shadows ON (turning them off changes every lit material's program key = a multi-hundred-ms recompile);
  // lower tiers only shrink the map
  const mapSize = tier === 'high' ? 2048 : tier === 'medium' ? 1024 : 512;
  const hemi = useRef<THREE.HemisphereLight>(null);
  const key = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.DirectionalLight>(null);
  // a shadow map is allocated once; changing the tier must drop it so three.js re-allocates at the new size
  useEffect(() => {
    const sh = key.current?.shadow;
    if (!sh) return;
    sh.map?.dispose();
    sh.map = null;
  }, [mapSize]);
  // toggling renderer.shadowMap.enabled changes every lit material's program key
  const firstShadow = useRef(true);
  useEffect(() => {
    if (firstShadow.current) {
      firstShadow.current = false;
      return;
    }
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m) [m].flat().forEach((x) => (x.needsUpdate = true));
    });
  }, [shadows, scene]);
  useFrame((_, dt) => {
    const v = useView.getState();
    const pipe = v.mode === 'pipe';
    const k = 1 - Math.exp(-dt * 3);
    const h = pipe ? 0.0 : v.mode === 'agents' ? 0.4 : 0.62;
    const kk = pipe ? 0 : v.mode === 'agents' ? 1.2 : 2.4;
    const f = pipe ? 0 : 0.55;
    if (hemi.current) hemi.current.intensity += (h - hemi.current.intensity) * k;
    if (key.current) key.current.intensity += (kk - key.current.intensity) * k;
    if (fill.current) fill.current.intensity += (f - fill.current.intensity) * k;
  });
  return (
    <>
      <hemisphereLight ref={hemi} args={['#cdd9ff', '#2a2f39', 0.62]} />
      <directionalLight
        ref={key}
        position={[11, 20, 14]}
        intensity={2.4}
        color="#fff1df"
        castShadow={shadows}
        shadow-mapSize={[mapSize, mapSize]}
        shadow-camera-left={-17}
        shadow-camera-right={17}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <directionalLight ref={fill} position={[-13, 9, -9]} intensity={0.55} color="#8db0ff" />
    </>
  );
}

function Backdrop() {
  const { scene } = useThree();
  const col = useRef(new THREE.Color('#090b0f'));
  useFrame((_, dt) => {
    const pipe = useView.getState().mode === 'pipe';
    // a sealed pipe has no sky: image-based lighting must vanish so the crawler's lamp is the only light
    const target = pipe ? 0 : 0.9;
    scene.environmentIntensity += (target - scene.environmentIntensity) * (1 - Math.exp(-dt * 5));
    if (pipe) {
      if (!scene.background) scene.background = new THREE.Color('#010203');
      (scene.background as THREE.Color).set('#010203');
      scene.fog = new THREE.Fog('#010203', 0.9, 6.5);
    } else {
      scene.background = null;
      scene.fog = null;
    }
    void col;
  });
  return null;
}

export function Scene({ shadows = true }: { shadows?: boolean }) {
  const mode = useView((s) => s.mode);
  const tileMode = useTileMode((s) => s.mode);
  const tier = useView((s) => s.quality);
  const gl = useThree((s) => s.gl);
  const software = useMemo(() => {
    try {
      const c = gl.getContext();
      const d = c.getExtension('WEBGL_debug_renderer_info');
      return isSoftwareRenderer(String(c.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : c.RENDERER)));
    } catch {
      return false;
    }
  }, [gl]);
  // Auto leaves the tile layer on for 20 s after it was last wanted: the Auto quality controller must not make the hall flip
  // between the procedural and the streamed scene (each flip re-draws the whole static scene) on a marginal frame budget
  const wantedNow = tilesWanted(tileMode, tier, software);
  const [holdUntil, setHoldUntil] = useState(0);
  useEffect(() => {
    if (wantedNow && tileMode === 'auto') setHoldUntil(performance.now() + 20_000);
  }, [wantedNow, tileMode]);
  const [, bump] = useState(0);
  useEffect(() => {
    if (wantedNow || tileMode !== 'auto') return;
    const left = holdUntil - performance.now();
    if (left <= 0) return;
    const t = setTimeout(() => bump((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [wantedNow, tileMode, holdUntil]);
  const streaming = wantedNow || (tileMode === 'auto' && performance.now() < holdUntil);
  const [tileState, setTiles] = useState<TileState>('off');
  useEffect(() => {
    if (!streaming) setTiles('off');
  }, [streaming]);
  // while the tile layer is ready the procedural static facility stays hidden; until LOD0 is resident, and whenever the manifest or
  // LOD0 fails (offline, 404, topology mismatch, decode error, embedded mock), the procedural facility is the visible LOD0
  const procedural = !(streaming && tileState === 'ready');
  // once the camera has glided into a sealed bore the hall is unseen — skip drawing it entirely
  const [inside, setInside] = useState(false);
  useEffect(() => {
    if (mode !== 'pipe') return setInside(false);
    const t = setTimeout(() => setInside(true), 1300);
    return () => clearTimeout(t);
  }, [mode]);
  return (
    <>
      <Backdrop />
      <ShaderWarmup />
      <SceneLights shadows={shadows} />
      <ShadowGovernor enabled={shadows} />
      <RelevanceProvider>
        {streaming && <TiledFacility onState={setTiles} />}
        <group visible={!inside && procedural}>
          <Facility />
          <HallDetail />
          <PlantContext />
          <Equipment />
          <Racks />
          <Pipes />
          <PipeSupports />
          <RackBranches />
        </group>
        <Robots />
        <HazardZones />
        <PipeInterior />
      </RelevanceProvider>
      <CameraRig />
    </>
  );
}
