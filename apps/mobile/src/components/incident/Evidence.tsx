import { useState } from 'react';
import { View } from 'react-native';
import { Activity, Eye, FileText, Map as MapIcon, ShieldCheck, Wrench, type LucideIcon } from 'lucide-react-native';
import { formatSimClock, labelOfId } from '@loopkeeper/core';
import type { Evidence as EvidenceT, Incident } from '@loopkeeper/core/contracts';
import { colors, toneColor, type Tone } from '@/theme';
import { Chip, PressableScale, Section, T } from '@/components/ui';

const KIND: Record<EvidenceT['kind'], { icon: LucideIcon; tone: Tone; label: string }> = {
  telemetry: { icon: Activity, tone: 'accent', label: 'Telemetry' },
  observation: { icon: Eye, tone: 'inpipe', label: 'Observation' },
  topology: { icon: MapIcon, tone: 'neutral', label: 'Topology' },
  verification: { icon: ShieldCheck, tone: 'sentinel', label: 'Verification' },
  action: { icon: Wrench, tone: 'outrig', label: 'Action' },
};

export function Evidence({ inc }: { inc: Incident }) {
  const [all, setAll] = useState(false);
  const items = [...inc.evidence].sort((a, b) => b.tick - a.tick);
  if (!items.length)
    return (
      <Section title="Evidence">
        <T v="callout" color={colors.t3}>
          Nothing recorded yet — evidence is attached as SENTINEL and the robots gather it.
        </T>
      </Section>
    );
  const shown = all ? items : items.slice(0, 5);
  return (
    <Section title={`Evidence · ${items.length}`}>
      <View style={{ gap: 2 }}>
        {shown.map((e, i) => {
          const k = KIND[e.kind] ?? { icon: FileText, tone: 'neutral' as Tone, label: e.kind };
          const Icon = k.icon;
          return (
            <View key={e.id} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: colors.line }}>
              <View style={{ width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' }}>
                <Icon size={13} color={toneColor[k.tone]} strokeWidth={2.2} />
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <T v="callout" color={colors.t1} style={{ lineHeight: 19 }}>
                  {e.summary}
                </T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <T v="monoSmall" color={colors.t4}>
                    {formatSimClock(e.tick * 0.5).slice(3)}
                  </T>
                  <T v="micro" color={colors.t3}>
                    {k.label}
                  </T>
                  {e.asset_id ? <Chip sm mono>{labelOfId(e.asset_id)}</Chip> : null}
                  {e.data
                    ? Object.entries(e.data)
                        .slice(0, 2)
                        .map(([key, val]) => (
                          <T key={key} v="monoSmall" color={colors.t3}>
                            {key}={typeof val === 'number' ? Number(val.toFixed(2)) : val}
                          </T>
                        ))
                    : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
      {items.length > 5 && (
        <PressableScale onPress={() => setAll((x) => !x)} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
          <T v="caption" color={colors.accent}>
            {all ? 'Show less' : `Show all ${items.length}`}
          </T>
        </PressableScale>
      )}
    </Section>
  );
}
