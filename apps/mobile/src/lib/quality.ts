import { PixelRatio } from 'react-native';
import * as Device from 'expo-device';

/**
 * The iOS Simulator renders OpenGL ES in software, so it automatically gets a low-cost profile; physical devices
 * keep the better one. Any EXPO_PUBLIC_* variable still overrides the automatic choice.
 */
export const IS_SIMULATOR = !Device.isDevice;

/**
 * Render scale for the 3D canvas. expo-gl renders at native pixel density (3x on current iPhones), so on a device
 * we target an effective ~2x (0.67 on a 3x phone). On the simulator we drop to 0.3.
 */
const env = Number(process.env.EXPO_PUBLIC_RENDER_SCALE);
const auto = IS_SIMULATOR ? 0.3 : Math.min(1, 2 / Math.max(1, PixelRatio.get()));
export const RENDER_SCALE = Math.min(1, Math.max(0.2, Number.isFinite(env) && env > 0 ? env : auto));

/** Target frame rate for the 3D canvas: 2 on the simulator, 30 on a device (EXPO_PUBLIC_RENDER_FPS overrides). */
const fpsEnv = Number(process.env.EXPO_PUBLIC_RENDER_FPS);
export const RENDER_FPS = Math.min(60, Math.max(1, Number.isFinite(fpsEnv) && fpsEnv > 0 ? fpsEnv : IS_SIMULATOR ? 2 : 30));

/** Skip blocking shader-link status queries: always on the simulator, opt-in elsewhere (EXPO_PUBLIC_FAST_GL=1). */
export const FAST_GL = IS_SIMULATOR || process.env.EXPO_PUBLIC_FAST_GL === '1';
