import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { colors } from '@/theme';
import { fontAssets } from '@/theme/fonts';
import { initMobileView } from '@/lib/camera';
import { useWorldBootstrap } from '@/hooks/useWorldBootstrap';
import { useAlerts } from '@/hooks/useAlerts';
import { useMotionSync } from '@/hooks/useMotionSync';
import { BootOverlay } from '@/components/BootOverlay';

void SplashScreen.preventAutoHideAsync();
initMobileView();

export default function RootLayout() {
  const [loaded] = useFonts(fontAssets);
  useWorldBootstrap();
  useAlerts();
  useMotionSync();
  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync();
  }, [loaded]);
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="incident/[id]" options={{ animation: 'slide_from_right' }} />
      </Stack>
      <BootOverlay />
    </GestureHandlerRootView>
  );
}
