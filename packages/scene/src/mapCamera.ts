import { create } from 'zustand';
import { useWorld } from '@loopkeeper/core/store';
import type { MountedDirection, RobotCameraClass } from './MountedCameraTransforms';
import type { CamGoal } from './view';

export type CameraMode = 'tactical' | 'first_person' | 'third_person';
export type ThirdPersonMode = 'chase' | 'orbit' | 'cutaway';

export interface MapCameraState {
  active: boolean;
  selectedRobotId: string;
  robotClass: RobotCameraClass;
  cameraMode: CameraMode;
  firstPersonDirection: MountedDirection;
  thirdPersonMode: ThirdPersonMode;
  gimbal: { yaw: number; pitch: number };
  orbitState: { azimuth: number; elevation: number; distance: number };
  immersiveHud: boolean;
  /** camera preset for the tactical view (Exterior, Cooling network, …); null = fitted whole-facility overview */
  tacticalGoal: CamGoal | null;

  setTactical(goal: CamGoal | null): void;
  setActive(v: boolean): void;
  /** true when the selected id is a robot that exists in the world on screen */
  hasRobot(): boolean;
  clearRobot(): void;
  selectRobot(id: string, klass?: RobotCameraClass): void;
  setCameraMode(mode: CameraMode): void;
  setFirstPersonDirection(dir: MountedDirection): void;
  setThirdPersonMode(mode: ThirdPersonMode): void;
  cycleCameraMode(): void;
  cycleFirstPersonDirection(): void;
  orbit(dAz: number, dEl: number): void;
  zoom(factor: number): void;
  look(dYaw: number, dPitch: number): void;
  resetGimbal(): void;
  toggleImmersiveHud(): void;
  setImmersiveHud(v: boolean): void;
}

const MODES: CameraMode[] = ['tactical', 'first_person', 'third_person'];
const DIRS: MountedDirection[] = ['front', 'rear', 'left', 'right', 'top'];

export const useMapCamera = create<MapCameraState>()((set, get) => ({
  active: false,
  selectedRobotId: '',
  robotClass: 'inpipe',
  cameraMode: 'tactical',
  firstPersonDirection: 'front',
  thirdPersonMode: 'chase',
  gimbal: { yaw: 0, pitch: 0 },
  orbitState: { azimuth: 0.62, elevation: 0.62, distance: 3.5 },
  immersiveHud: false,
  tacticalGoal: null,

  setTactical: (tacticalGoal) => set({ tacticalGoal, cameraMode: 'tactical' }),
  setActive: (active) => set({ active }),
  hasRobot: () => !!get().selectedRobotId && !!useWorld.getState().robots[get().selectedRobotId],
  clearRobot: () => set({ selectedRobotId: '', cameraMode: 'tactical' }),

  selectRobot: (id, klass) =>
    set((s) => {
      const actualClass: RobotCameraClass = klass ?? (id.startsWith('o_') || id.toLowerCase().includes('outrig') ? 'outrig' : 'inpipe');
      // If switching class and cutaway was selected for outrig, fallback to chase
      const tpMode = actualClass === 'outrig' && s.thirdPersonMode === 'cutaway' ? 'chase' : s.thirdPersonMode;
      return {
        selectedRobotId: id,
        tacticalGoal: null,
        robotClass: actualClass,
        thirdPersonMode: tpMode,
        gimbal: { yaw: 0, pitch: 0 },
      };
    }),

  setCameraMode: (cameraMode) =>
    set((s) => {
      // If switching to third person and cutaway on outrig, adjust
      const tpMode = s.robotClass === 'outrig' && s.thirdPersonMode === 'cutaway' ? 'chase' : s.thirdPersonMode;
      return { cameraMode, thirdPersonMode: tpMode };
    }),

  setFirstPersonDirection: (firstPersonDirection) =>
    set({ firstPersonDirection, cameraMode: 'first_person', gimbal: { yaw: 0, pitch: 0 } }),

  setThirdPersonMode: (thirdPersonMode) =>
    set({ thirdPersonMode, cameraMode: 'third_person' }),

  cycleCameraMode: () => {
    const cur = get().cameraMode;
    const idx = MODES.indexOf(cur);
    const next = MODES[(idx + 1) % MODES.length];
    get().setCameraMode(next);
  },

  cycleFirstPersonDirection: () => {
    const cur = get().firstPersonDirection;
    const idx = DIRS.indexOf(cur);
    const next = DIRS[(idx + 1) % DIRS.length];
    get().setFirstPersonDirection(next);
  },

  orbit: (dAz, dEl) =>
    set((s) => ({
      orbitState: {
        azimuth: s.orbitState.azimuth + dAz,
        elevation: Math.max(0.1, Math.min(1.4, s.orbitState.elevation + dEl)),
        distance: s.orbitState.distance,
      },
    })),

  zoom: (factor) =>
    set((s) => ({
      orbitState: {
        ...s.orbitState,
        distance: Math.max(1.2, Math.min(12, s.orbitState.distance * factor)),
      },
    })),

  look: (dYaw, dPitch) =>
    set((s) => ({
      gimbal: {
        yaw: s.gimbal.yaw + dYaw,
        pitch: Math.max(-0.6, Math.min(0.6, s.gimbal.pitch + dPitch)),
      },
    })),

  resetGimbal: () => set({ gimbal: { yaw: 0, pitch: 0 } }),

  toggleImmersiveHud: () => set((s) => ({ immersiveHud: !s.immersiveHud })),
  setImmersiveHud: (immersiveHud) => set({ immersiveHud }),
}));
