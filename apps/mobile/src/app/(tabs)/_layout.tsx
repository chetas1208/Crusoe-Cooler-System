import { Tabs } from 'expo-router';
import { colors } from '@/theme';
import { TabBar } from '@/components/TabBar';

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, freezeOnBlur: true }}>
      <Tabs.Screen name="index" options={{ title: 'Live', freezeOnBlur: false }} />
      <Tabs.Screen name="incidents" options={{ title: 'Incidents' }} />
      <Tabs.Screen name="fleet" options={{ title: 'Fleet' }} />
      <Tabs.Screen name="system" options={{ title: 'System' }} />
    </Tabs>
  );
}
