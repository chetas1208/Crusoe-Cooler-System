import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { useTabBarHeight } from '@/components/TabBar';
import { PressableScale, T } from '@/components/ui';

const BAR_H = 46;

interface Props {
  title: string;
  /** large-title tab roots, or a pushed detail screen with a back affordance */
  variant?: 'large' | 'detail';
  backLabel?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * iOS-style scaffold: a large title that collapses into a blurred compact bar as the content scrolls,
 * safe-area aware, with room for the floating tab bar. (We draw it ourselves so the Geist type and the
 * glass language match the Live screen exactly.)
 */
export function ScreenScroll({ title, variant = 'large', backLabel, right, children, contentStyle }: Props) {
  const insets = useSafeAreaInsets();
  const tabH = useTabBarHeight();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    y.value = e.contentOffset.y;
  });
  const detail = variant === 'detail';
  const barBg = useAnimatedStyle(() => ({ opacity: detail ? 1 : interpolate(y.value, [18, 52], [0, 1], Extrapolation.CLAMP) }));
  const compactTitle = useAnimatedStyle(() => ({
    opacity: detail ? interpolate(y.value, [10, 50], [0, 1], Extrapolation.CLAMP) : interpolate(y.value, [26, 54], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(y.value, [26, 54], [5, 0], Extrapolation.CLAMP) }],
  }));
  const largeTitle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [0, 40], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(y.value, [-80, 0, 60], [10, 0, -10], Extrapolation.CLAMP) }, { scale: interpolate(y.value, [-120, 0], [1.06, 1], Extrapolation.CLAMP) }],
  }));
  const top = insets.top;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[{ paddingTop: top + (detail ? BAR_H + 6 : BAR_H + 2), paddingBottom: tabH + 28 }, contentStyle]}
      >
        {!detail && (
          <Animated.View style={[{ paddingBottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, largeTitle]}>
            <T v="largeTitle" style={{ fontSize: 34, lineHeight: 41, letterSpacing: -1.1 }}>
              {title}
            </T>
            {right}
          </Animated.View>
        )}
        {children}
      </Animated.ScrollView>

      {/* compact blurred bar */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: top + BAR_H }}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, barBg]}>
          <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(9,11,15,0.72)' }]} />
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.line2 }} />
        </Animated.View>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: BAR_H, alignItems: 'center', justifyContent: 'center' }}>
          <Animated.View style={compactTitle} pointerEvents="none">
            <T v="headline" style={{ fontSize: 16.5 }}>
              {title}
            </T>
          </Animated.View>
        </View>
        {detail && (
          <PressableScale
            accessibilityLabel="Back"
            onPress={() => {
              haptic.light();
              router.back();
            }}
            scaleTo={0.92}
            style={{ position: 'absolute', left: 8, bottom: 0, height: BAR_H, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 2 }}
          >
            <ChevronLeft size={26} color={colors.accent} strokeWidth={2.4} />
            <T v="body" color={colors.accent} style={{ fontSize: 16.5 }}>
              {backLabel ?? 'Back'}
            </T>
          </PressableScale>
        )}
      </View>
    </View>
  );
}
