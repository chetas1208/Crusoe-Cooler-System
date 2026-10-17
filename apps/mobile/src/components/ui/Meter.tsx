import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { toneColor, type Tone } from '@/theme';

export function Meter({ value, tone = 'accent', height = 4, style }: { value: number; tone?: Tone; height?: number; style?: StyleProp<ViewStyle> }) {
  const v = useSharedValue(Math.max(0, Math.min(1, value)));
  useEffect(() => {
    v.value = withTiming(Math.max(0, Math.min(1, value)), { duration: 520, easing: Easing.out(Easing.cubic) });
  }, [value, v]);
  const a = useAnimatedStyle(() => ({ width: `${v.value * 100}%` }));
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }, style]}>
      <Animated.View style={[{ height: '100%', borderRadius: height / 2, backgroundColor: toneColor[tone] }, a]} />
    </View>
  );
}
