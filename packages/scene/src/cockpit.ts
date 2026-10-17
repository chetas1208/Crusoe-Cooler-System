import { create } from 'zustand';

/**
 * Robot-cockpit camera selection. Lives beside the view store so the one render camera (CameraRig) and the
 * crawler lamp (PipeInterior) can follow a specific robot instead of "whatever crawler is in this segment".
 */
export type CockpitCam = 'chase' | 'nose' | 'rear' | 'side' | 'top';

export const COCKPIT_CAMS: Array<{ id: CockpitCam; label: string; key: string }> = [
  { id: 'chase', label: 'Chase', key: '1' },
  { id: 'nose', label: 'Nose', key: '2' },
  { id: 'rear', label: 'Rear', key: '3' },
  { id: 'side', label: 'Side', key: '4' },
  { id: 'top', label: 'Top', key: '5' },
];

interface CockpitState {
  /** the robot the cockpit camera rides on (null = legacy "crawler in this segment" behaviour) */
  robotId: string | null;
  cam: CockpitCam;
  setRobot(id: string | null): void;
  setCam(c: CockpitCam): void;
}

export const useCockpit = create<CockpitState>()((set) => ({
  robotId: null,
  cam: 'chase',
  setRobot: (robotId) => set({ robotId }),
  setCam: (cam) => set({ cam }),
}));
