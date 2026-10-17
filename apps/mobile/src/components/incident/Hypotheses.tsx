import { View } from 'react-native';
import type { Incident } from '@loopkeeper/core/contracts';
import { colors } from '@/theme';
import { Meter, Section, T } from '@/components/ui';

export function Hypotheses({ inc }: { inc: Incident }) {
  if (!inc.hypotheses.length) return null;
  return (
    <Section title="Hypotheses">
      <View style={{ gap: 11 }}>
        {inc.hypotheses.slice(0, 4).map((h) => {
          const confirmed = h.status === 'confirmed';
          const refuted = h.status === 'refuted';
          return (
            <View key={h.id} style={{ gap: 6, opacity: refuted ? 0.5 : 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <T v="callout" color={confirmed ? colors.nominal : colors.t2} style={{ flex: 1, textDecorationLine: refuted ? 'line-through' : 'none', fontFamily: confirmed ? 'Geist_600SemiBold' : 'Geist_400Regular' }} numberOfLines={2}>
                  {h.label}
                </T>
                <T v="mono" color={confirmed ? colors.nominal : colors.t3}>
                  {confirmed ? 'confirmed' : refuted ? 'ruled out' : `${Math.round(h.confidence * 100)}%`}
                </T>
              </View>
              <Meter value={Math.max(0.02, h.confidence)} tone={confirmed ? 'nominal' : 'sentinel'} height={4} />
            </View>
          );
        })}
      </View>
    </Section>
  );
}
