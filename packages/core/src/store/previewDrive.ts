import { create } from 'zustand';

export interface GhostPose {
  position_xyz_m: [number, number, number];
  yaw_rad: number;
  segment_id?: string;
  s_m?: number;
  speed_m_s: number;
}

export interface PreviewDriveStore {
  active: boolean;
  robotId: string | null;
  robotClass: 'outrig' | 'inpipe';
  ghostPose: GhostPose | null;
  initialPose: GhostPose | null;
  distanceTraveledM: number;
  lastInputTime: number;

  startPreview: (robotId: string, robotClass: 'outrig' | 'inpipe', initialPose: GhostPose) => void;
  updateGhostInput: (
    input: { throttle: number; steer: number; brake: boolean },
    dtSeconds: number,
    bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
  ) => void;
  exitPreview: () => void;
}

const DEFAULT_BOUNDS = { minX: -1.0, maxX: 33.0, minZ: -1.0, maxZ: 19.0 };

export const usePreviewDrive = create<PreviewDriveStore>((set, get) => ({
  active: false,
  robotId: null,
  robotClass: 'outrig',
  ghostPose: null,
  initialPose: null,
  distanceTraveledM: 0,
  lastInputTime: 0,

  startPreview: (robotId, robotClass, initialPose) => {
    set({
      active: true,
      robotId,
      robotClass,
      initialPose: { ...initialPose },
      ghostPose: { ...initialPose, speed_m_s: 0 },
      distanceTraveledM: 0,
      lastInputTime: Date.now(),
    });
  },

  updateGhostInput: (input, dtSeconds, bounds = DEFAULT_BOUNDS) => {
    const state = get();
    if (!state.active || !state.ghostPose) return;

    const dt = Math.max(0.001, Math.min(dtSeconds, 0.2));
    const pose = { ...state.ghostPose };

    if (state.robotClass === 'inpipe') {
      // In-pipe crawler: 1D path coordinate along pipe segment
      const speed = input.brake ? 0 : input.throttle * 0.45; // m/s
      const ds = speed * dt;
      const curS = pose.s_m ?? 0;
      const nextS = Math.max(0, curS + ds);
      pose.s_m = nextS;
      pose.speed_m_s = Math.abs(speed);

      set({
        ghostPose: pose,
        distanceTraveledM: state.distanceTraveledM + Math.abs(ds),
        lastInputTime: Date.now(),
      });
      return;
    }

    // Outrig floor rover: 2D kinematic unicycle motion
    const turnRate = 1.6; // rad/s
    const maxSpeed = 1.35; // m/s
    const curYaw = pose.yaw_rad;
    const nextYaw = (curYaw + input.steer * turnRate * dt + Math.PI * 2) % (Math.PI * 2);

    const targetSpeed = input.brake ? 0 : input.throttle * maxSpeed;
    const speed = targetSpeed;
    const dx = Math.sin(nextYaw) * speed * dt;
    const dz = Math.cos(nextYaw) * speed * dt;

    const curX = pose.position_xyz_m[0];
    const curY = pose.position_xyz_m[1];
    const curZ = pose.position_xyz_m[2];

    const nextX = Math.max(bounds.minX, Math.min(bounds.maxX, curX + dx));
    const nextZ = Math.max(bounds.minZ, Math.min(bounds.maxZ, curZ + dz));

    const actualDist = Math.hypot(nextX - curX, nextZ - curZ);

    pose.position_xyz_m = [nextX, curY, nextZ];
    pose.yaw_rad = nextYaw;
    pose.speed_m_s = Math.abs(speed);

    set({
      ghostPose: pose,
      distanceTraveledM: state.distanceTraveledM + actualDist,
      lastInputTime: Date.now(),
    });
  },

  exitPreview: () => {
    set({
      active: false,
      robotId: null,
      ghostPose: null,
      initialPose: null,
      distanceTraveledM: 0,
    });
  },
}));
