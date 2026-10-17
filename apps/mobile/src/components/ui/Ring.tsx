import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { colors, toneColor, type Tone } from '@/theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface RingProps {
  /** 0..1 */
  value: number;
  size?: number;
  stroke?: number;
  tone?: Tone;
  children?: React.ReactNode;
}

/** Progress ring (approval countdown, verification window). */
export function Ring({ value, size = 44, stroke = 3.5, tone = 'accent', children }: RingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = useSharedValue(Math.max(0.001, Math.min(1, value)));
  useEffect(() => {
    v.value = withTiming(Math.max(0.001, Math.min(1, value)), { duration: 480, easing: Easing.out(Easing.cubic) });
  }, [value, v]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - v.value) }));
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={stroke} />
        <AnimatedCircle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={toneColor[tone] ?? colors.accent} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} animatedProps={props} />
      </Svg>
      {children ? <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>{children}</View> : null}
    </View>
  );
}
