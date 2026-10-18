import { Tabs } from 'expo-router';
import { colors } from '@/theme';
import { TabBar } from '@/components/TabBar';
import { ReplayBanner } from '@/components/ReplayBanner';
import { useRunsPolling } from '@/hooks/useRuns';

export default function TabsLayout() {
  useRunsPolling();
  return (
    <>
      <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, freezeOnBlur: false }}>
        <Tabs.Screen name="index" options={{ title: 'Dashboard' }} />
        <Tabs.Screen name="map" options={{ title: 'Map' }} />
        <Tabs.Screen name="agents" options={{ title: 'Agents' }} />
        <Tabs.Screen name="execution" options={{ title: 'Execution' }} />
      </Tabs>
      <ReplayBanner />
    </>
  );
}
