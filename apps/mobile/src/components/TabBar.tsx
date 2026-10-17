import { useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Bot, Orbit, SlidersHorizontal, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { colors, toneColor } from '@/theme';
import { haptic } from '@/lib/haptics';
import { useOpenIncidents } from '@/hooks/useIncidents';
import { PressableScale, T } from '@/components/ui';

export const TAB_BAR_CONTENT = 54;
export function useTabBarHeight() {
  return TAB_BAR_CONTENT + useSafeAreaInsets().bottom;
}

const ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  index: { icon: Orbit, label: 'Live' },
  incidents: { icon: TriangleAlert, label: 'Incidents' },
  fleet: { icon: Bot, label: 'Fleet' },
  system: { icon: SlidersHorizontal, label: 'System' },
};

/** Blurred bottom tab bar with a spring-sliding indicator and a severity-coloured incident badge. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const [w, setW] = useState(0);
  const x = useSharedValue(state.index);
  useEffect(() => {
    x.value = withSpring(state.index, { stiffness: 420, damping: 34, mass: 0.8 });
  }, [state.index, x]);
  const n = state.routes.length;
  const seg = w / n;
  const ind = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * seg + seg / 2 - 22 }] }));
  const open = useOpenIncidents();
  const worst = open[0];
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: TAB_BAR_CONTENT + insets.bottom }} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
      <BlurView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(9,11,15,0.78)' }]} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.line2 }} />
      {w > 0 && <Animated.View style={[{ position: 'absolute', top: 5, width: 44, height: 3, borderRadius: 2, backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } }, ind]} />}
      <View style={{ flexDirection: 'row', height: TAB_BAR_CONTENT, paddingTop: 6 }}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const meta = ICONS[route.name] ?? ICONS.index;
          const Icon = meta.icon;
          const color = focused ? colors.accent : colors.t3;
          const badge = route.name === 'incidents' && open.length > 0;
          return (
            <PressableScale
              key={route.key}
              scaleTo={0.9}
              accessibilityRole="button"
              accessibilityLabel={meta.label}
              onPress={() => {
                const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !ev.defaultPrevented) {
                  haptic.select();
                  navigation.navigate(route.name, route.params);
                }
              }}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 }}
            >
              <View>
                <Icon size={22} color={color} strokeWidth={focused ? 2.3 : 1.9} />
                {badge && (
                  <View style={{ position: 'absolute', top: -5, right: -9, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: toneColor[worst.severity === 'nominal' ? 'accent' : worst.severity], borderWidth: 2, borderColor: colors.bg }}>
                    <T v="micro" color="#10131a" style={{ fontFamily: 'Geist_700Bold', fontSize: 9.5, lineHeight: 12 }}>
                      {open.length}
                    </T>
                  </View>
                )}
              </View>
              <T v="micro" color={color} style={{ fontSize: 10.5, fontFamily: focused ? 'Geist_600SemiBold' : 'Geist_500Medium' }}>
                {meta.label}
              </T>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}
