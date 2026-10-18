/** Web build: the 3D scene is native-only (R3F-native + expo-gl); the 2D tactical map is used instead. */
export type PresetId = 'whole' | 'plant' | 'zone_a' | 'zone_b';
export const MOBILE_PRESETS = {} as Record<PresetId, never>;
export const PRESET_LABEL: Record<PresetId, string> = { whole: 'Whole', plant: 'Plant', zone_a: 'Zone A', zone_b: 'Zone B' };
export function applyCameraPreset(_id: PresetId) {}
export function initMobileView() {}
