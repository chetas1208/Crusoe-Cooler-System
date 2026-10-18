import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeOut, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useWorld } from '@loopkeeper/core/store';
import { PRODUCT_BRAND } from '@loopkeeper/core';
import { colors } from '@/theme';
import { resolveApiUrl } from '@/lib/api';
import { LogoMark, T } from '@/components/ui';
import { AuthGate } from '@/components/AuthGate';

function SpinningMark() {
  const reduce = useReducedMotion();
  const r = useSharedValue(0);
  useEffect(() => {
    if (!reduce) r.value = withRepeat(withTiming(360, { duration: 2400, easing: Easing.linear }), -1);
  }, [reduce, r]);
  const a = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  return (
    <Animated.View style={a}>
      <LogoMark size={46} />
    </Animated.View>
  );
}

/** Shown until the first snapshot lands; says plainly when the backend can't be reached. */
export function BootOverlay() {
  const phase = useWorld((s) => s.phase);
  const error = useWorld((s) => s.error);
  if (phase === 'ready') return null;
  const failed = phase === 'error';
  return (
    <Animated.View exiting={FadeOut.duration(450)} style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 22, zIndex: 50 }]}>
      <SpinningMark />
      <View style={{ alignItems: 'center', gap: 6 }}>
        <T v="title" style={{ letterSpacing: 2.5, fontSize: 16, fontFamily: 'Geist_600SemiBold' }}>
          {PRODUCT_BRAND.name}
        </T>
        <T v="callout" color={colors.t3}>
          Autonomous maintenance twin
        </T>
      </View>
      <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 40, minHeight: 74 }}>
        {failed ? (
          <>
            <T v="caption" color={colors.warning} style={{ fontFamily: 'Geist_600SemiBold' }}>
              Can’t reach the facility backend
            </T>
            <T v="monoSmall" color={colors.t3}>
              {resolveApiUrl()}
            </T>
            <T v="micro" color={colors.t4} style={{ textAlign: 'center' }}>
              Retrying automatically{error ? ` · ${error}` : ''}. Set EXPO_PUBLIC_API_URL to the backend.
            </T>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.accent} />
            <T v="caption" color={colors.t2}>
              Connecting to the facility…
            </T>
          </>
        )}
      </View>
      <View style={{ position: 'absolute', left: 20, right: 20, bottom: 60 }}>
        <AuthGate />
      </View>
    </Animated.View>
  );
}
