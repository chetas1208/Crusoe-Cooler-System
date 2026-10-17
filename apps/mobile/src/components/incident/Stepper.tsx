import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { Check } from 'lucide-react-native';
import { STAGES, type Incident } from '@loopkeeper/core/contracts';
import { STAGE_LABEL } from '@loopkeeper/core';
import { colors, alpha } from '@/theme';
import { T } from '@/components/ui';

function CurrentNode({ color }: { color: string }) {
  const reduce = useReducedMotion();
  const k = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    k.value = withRepeat(withSequence(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 0 })), -1);
  }, [reduce, k]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - k.value), transform: [{ scale: 1 + k.value * 1.1 }] }));
  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: 16, height: 16, borderRadius: 8, backgroundColor: color }, halo]} />
      <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: color, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      </View>
    </View>
  );
}

/** Observed → Hypothesized → Investigated → Repaired → Verified. */
export function Stepper({ inc, compact, showRetry }: { inc: Incident; compact?: boolean; showRetry?: boolean }) {
  const idx = STAGES.indexOf(inc.stage);
  const closed = inc.status === 'resolved' || inc.status === 'dismissed';
  const rejected = inc.stage_log.some((l) => l.outcome === 'rejected');
  const color = inc.status === 'dismissed' ? colors.isolated : closed ? colors.nominal : colors.accent;
  return (
    <View>
      <View style={{ flexDirection: 'row' }}>
        {STAGES.map((s, i) => {
          const done = i < idx || (i === idx && closed);
          const cur = i === idx && !done;
          const leftFill = i <= idx;
          const rightFill = i < idx || (done && i === idx);
          const sz = compact ? 8 : 16;
          return (
            <View key={s} style={{ flex: 1, alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%', height: sz + 2 }}>
                <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: i === 0 ? 'transparent' : leftFill ? alpha(color, 0.85) : 'rgba(255,255,255,0.1)' }} />
                {done ? (
                  <View style={{ width: sz, height: sz, borderRadius: sz / 2, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
                    {!compact && <Check size={10} color="#06201c" strokeWidth={3.4} />}
                  </View>
                ) : cur ? (
                  compact ? (
                    <View style={{ width: sz, height: sz, borderRadius: sz / 2, borderWidth: 2, borderColor: color, backgroundColor: colors.bg }} />
                  ) : (
                    <CurrentNode color={color} />
                  )
                ) : (
                  <View style={{ width: compact ? 6 : 10, height: compact ? 6 : 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.12)' }} />
                )}
                <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: i === STAGES.length - 1 ? 'transparent' : rightFill ? alpha(color, 0.85) : 'rgba(255,255,255,0.1)' }} />
              </View>
              {!compact && (
                <T v="micro" color={cur ? colors.t1 : done ? colors.t2 : colors.t4} style={{ marginTop: 7, fontSize: 10, fontFamily: cur ? 'Geist_600SemiBold' : 'Geist_500Medium' }} numberOfLines={1}>
                  {STAGE_LABEL[s]}
                </T>
              )}
            </View>
          );
        })}
      </View>
      {rejected && showRetry && !compact && (
        <T v="micro" color={colors.warning} style={{ marginTop: 8 }}>
          ↺ A repair was rejected by the verifier and replanned
        </T>
      )}
    </View>
  );
}
