import Constants from 'expo-constants';

/**
 * Where the facility backend lives.
 *  1. EXPO_PUBLIC_API_URL  — explicit (physical phone: the LAN URL `pnpm dev:api` prints)
 *  2. the dev machine's address Metro served this bundle from, on the mock-api port
 *  3. localhost (iOS Simulator / Android emulator with adb reverse)
 * No credentials are ever embedded in the client.
 */
export function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host && /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return `http://${host}:8787`;
  return 'http://localhost:8787';
}
