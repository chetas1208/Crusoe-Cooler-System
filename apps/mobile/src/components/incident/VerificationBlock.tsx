import { View } from 'react-native';
import { Check, ShieldCheck, X } from 'lucide-react-native';
import type { Incident } from '@loopkeeper/core/contracts';
import { alpha, colors } from '@/theme';
import { Chip, Ring, T } from '@/components/ui';

/** Independent physics check: stabilisation window while pending, then before → after for every check. */
export function VerificationBlock({ inc }: { inc: Incident }) {
  const v = inc.verification;
  if (!v) return null;
  if (v.status === 'pending') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, padding: 14, borderRadius: 16, backgroundColor: alpha(colors.sentinel, 0.08), borderWidth: 1, borderColor: alpha(colors.sentinel, 0.24) }}>
        <Ring value={v.progress} size={44} stroke={3.5} tone="sentinel">
          <ShieldCheck size={15} color={colors.sentinel} strokeWidth={2.2} />
        </Ring>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="headline" style={{ fontSize: 14.5 }}>
            Independent verification
          </T>
          <T v="caption" color={colors.t2}>
            Stabilisation window · {Math.round(v.elapsed_s)} / {Math.round(v.window_s)} s of simulated time
          </T>
        </View>
        <Chip tone="sentinel" sm>
          PENDING
        </Chip>
      </View>
    );
  }
  const ok = v.status === 'verified';
  const c = ok ? colors.nominal : colors.critical;
  return (
    <View style={{ padding: 14, borderRadius: 16, gap: 12, backgroundColor: alpha(c, 0.07), borderWidth: 1, borderColor: alpha(c, 0.26) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: alpha(c, 0.18), alignItems: 'center', justifyContent: 'center' }}>
          {ok ? <Check size={15} color={c} strokeWidth={3} /> : <X size={15} color={c} strokeWidth={3} />}
        </View>
        <View style={{ flex: 1 }}>
          <T v="headline" style={{ fontSize: 14.5 }}>
            {ok ? 'Verified by physics' : 'Rejected — plant did not recover'}
          </T>
          <T v="caption" color={colors.t2}>
            attempt {v.attempt} · confidence {Math.round(v.confidence * 100)}%
          </T>
        </View>
      </View>
      {v.failed_reason ? (
        <T v="callout" color={colors.t2}>
          {v.failed_reason}
        </T>
      ) : null}
      <View style={{ gap: 9 }}>
        {v.checks.map((ch) => (
          <View key={ch.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            <View style={{ width: 17, height: 17, borderRadius: 9, backgroundColor: alpha(ch.pass ? colors.nominal : colors.critical, 0.2), alignItems: 'center', justifyContent: 'center' }}>
              {ch.pass ? <Check size={10} color={colors.nominal} strokeWidth={3.4} /> : <X size={10} color={colors.critical} strokeWidth={3.4} />}
            </View>
            <T v="callout" color={colors.t2} style={{ flex: 1, fontSize: 13 }} numberOfLines={1}>
              {ch.label}
            </T>
            <T v="mono" color={colors.t3} style={{ fontSize: 12 }}>
              {ch.before.toFixed(2)} <T v="mono" color={colors.t4}>→</T> <T v="mono" color={colors.t1} style={{ fontFamily: 'GeistMono_600SemiBold' }}>{ch.after.toFixed(2)}</T> <T v="monoSmall" color={colors.t4}>{ch.unit}</T>
            </T>
          </View>
        ))}
      </View>
    </View>
  );
}
