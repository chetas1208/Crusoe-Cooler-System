import { useEffect } from 'react';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { toneColor, type Tone } from '@/theme';

export function Dot({ tone = 'nominal', pulse, size = 7 }: { tone?: Tone; pulse?: boolean; size?: number }) {
  const reduce = useReducedMotion();
  const k = useSharedValue(1);
  useEffect(() => {
    if (pulse && !reduce) {
      k.value = withRepeat(withSequence(withTiming(0.4, { duration: 900, easing: Easing.inOut(Easing.quad) }), withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) })), -1);
    } else k.value = 1;
  }, [pulse, reduce, k]);
  const a = useAnimatedStyle(() => ({ opacity: k.value, transform: [{ scale: 0.82 + 0.18 * k.value }] }));
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: toneColor[tone] }, a]} />;
}
