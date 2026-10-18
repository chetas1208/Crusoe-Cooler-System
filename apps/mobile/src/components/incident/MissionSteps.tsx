import { View } from 'react-native';
import { alpha, colors } from '@/theme';
import { T } from '@/components/ui';

export function MissionSteps({ steps }: { steps: { id: string; label: string; status: string; result?: string }[] }) {
  return (
    <View style={{ gap: 0 }}>
      {steps.map((s, i) => {
        const c = s.status === 'done' ? colors.nominal : s.status === 'active' ? colors.accent : s.status === 'failed' ? colors.critical : colors.t4;
        return (
          <View key={s.id} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ alignItems: 'center', width: 14 }}>
              <View style={{ marginTop: 5, width: 10, height: 10, borderRadius: 5, backgroundColor: s.status === 'done' || s.status === 'failed' ? c : colors.bg, borderWidth: 2, borderColor: c }}>
                {s.status === 'active' ? <View style={{ position: 'absolute', left: 1.5, top: 1.5, width: 3, height: 3, borderRadius: 2, backgroundColor: c }} /> : null}
              </View>
              {i < steps.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: s.status === 'done' ? alpha(colors.nominal, 0.5) : 'rgba(255,255,255,0.08)', marginTop: 2 }} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: 11 }}>
              <T v="callout" color={s.status === 'pending' || s.status === 'skipped' ? colors.t3 : colors.t1} style={{ fontFamily: s.status === 'active' ? 'Geist_600SemiBold' : 'Geist_400Regular', lineHeight: 20 }}>
                {s.label}
              </T>
              {s.result ? <T v="micro" color={colors.t3}>{s.result}</T> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
