import { useView, type CamGoal } from '@loopkeeper/scene';

/**
 * Camera framings tuned for a portrait phone. The shared presets assume a landscape desktop viewport;
 * on a ~0.46 aspect screen we orient the hall's long axis up the screen and widen the lens.
 */
export type PresetId = 'whole' | 'plant' | 'zone_a' | 'zone_b';

export const MOBILE_PRESETS: Record<PresetId, CamGoal> = {
  whole: { azimuth: 1.18, elevation: 0.86, distance: 40, target: [-2.4, 0.4, 0.2], fov: 42 },
  plant: { azimuth: 1.05, elevation: 0.62, distance: 17, target: [-7.6, 1.0, -1.4], fov: 42 },
  zone_a: { azimuth: 0.5, elevation: 0.62, distance: 15, target: [-0.6, 1.2, -2.7], fov: 42 },
  zone_b: { azimuth: 0.7, elevation: 0.64, distance: 15, target: [-0.6, 1.2, 2.7], fov: 42 },
};

export const PRESET_LABEL: Record<PresetId, string> = { whole: 'Whole', plant: 'Plant', zone_a: 'Zone A', zone_b: 'Zone B' };

export function applyCameraPreset(id: PresetId) {
  const v = useView.getState();
  if (v.mode === 'pipe') v.exitPipe();
  v.follow(null);
  v.select(null);
  useView.setState({ xray: false });
  v.setCam(MOBILE_PRESETS[id]);
}

/** Initial framing before the first frame (no cinematic glide from the desktop default). */
export function initMobileView() {
  useView.setState({ cam: MOBILE_PRESETS.whole, quality: 'low' });

}
