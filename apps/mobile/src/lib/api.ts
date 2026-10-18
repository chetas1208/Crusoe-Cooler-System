import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Where the facility backend lives.
 *  1. EXPO_PUBLIC_API_URL  — explicit (physical phone: the LAN URL the backend prints; web build: the API origin)
 *  2. the dev machine's address Metro served this bundle from, on the default API port
 *  3. localhost (iOS Simulator / Android emulator with adb reverse)
 * No credentials are ever embedded in the client: an operator token, if the backend wants one, is typed in at
 * runtime and held in memory only (see components/AuthGate).
 */
export function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') return `${window.location.protocol}//${window.location.hostname}:8787`;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host && /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return `http://${host}:8787`;
  return 'http://localhost:8787';
}
