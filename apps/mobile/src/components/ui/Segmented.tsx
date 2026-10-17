import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { PressableScale } from './PressableScale';
import { T } from './Text';

interface Item<K extends string> {
  id: K;
  label: string;
  count?: number;
}

/** iOS-style segmented control with a spring-driven thumb. */
export function Segmented<K extends string>({ items, value, onChange, style, small }: { items: Item<K>[]; value: K; onChange: (v: K) => void; style?: StyleProp<ViewStyle>; small?: boolean }) {
  const [w, setW] = useState(0);
  const idx = Math.max(0, items.findIndex((i) => i.id === value));
  const x = useSharedValue(idx);
  useEffect(() => {
    x.value = withSpring(idx, { stiffness: 520, damping: 38, mass: 0.7 });
  }, [idx, x]);
  const seg = w > 0 ? (w - 4) / items.length : 0;
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * seg }] }));
  const h = small ? 32 : 38;
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} style={[{ height: h, borderRadius: 11, padding: 2, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.line, flexDirection: 'row' }, style]}>
      {w > 0 && <Animated.View style={[{ position: 'absolute', left: 2, top: 2, bottom: 2, width: seg, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.13)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }, thumb]} />}
      {items.map((it) => {
        const on = it.id === value;
        return (
          <PressableScale
            key={it.id}
            scaleTo={0.97}
            onPress={() => {
              if (!on) {
                haptic.select();
                onChange(it.id);
              }
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 5 }}
          >
            <T v="caption" color={on ? colors.t1 : colors.t3} style={{ fontSize: small ? 12 : 13, fontFamily: on ? 'Geist_600SemiBold' : 'Geist_500Medium' }}>
              {it.label}
            </T>
            {it.count !== undefined ? (
              <T v="monoSmall" color={on ? colors.t2 : colors.t4}>
                {it.count}
              </T>
            ) : null}
          </PressableScale>
        );
      })}
    </View>
  );
}
