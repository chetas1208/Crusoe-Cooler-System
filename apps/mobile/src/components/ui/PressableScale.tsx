import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Props extends PressableProps {
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
}

/** Pressable with a springy press-in, the way iOS controls feel. */
export function PressableScale({ style, scaleTo = 0.965, onPressIn, onPressOut, children, ...rest }: Props) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        s.set(withSpring(scaleTo, { stiffness: 600, damping: 30, mass: 0.6 }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        s.set(withSpring(1, { stiffness: 420, damping: 20, mass: 0.6 }));
        onPressOut?.(e);
      }}
      style={[a, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
