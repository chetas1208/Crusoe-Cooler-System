import { View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { INCIDENT_STATUS_LABEL, formatDuration } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import { colors, toneColor } from '@/theme';
import { haptic } from '@/lib/haptics';
import { incidentTone } from '@/hooks/useIncidents';
import { Chip, Dot, PressableScale, T } from '@/components/ui';
import { Stepper } from './Stepper';
import { SeverityBadge } from './IncidentHeader';

export function IncidentRow({ inc, onPress }: { inc: Incident; onPress: () => void }) {
  const simTime = useWorld((s) => s.simTimeS);
  const tone = incidentTone(inc);
  const closed = !!inc.closed_tick;
  const approval = inc.approval && (inc.approval.status === 'pending' || inc.approval.status === 'held');
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={() => {
        haptic.light();
        onPress();
      }}
    >
      <View style={{ borderRadius: 18, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: approval ? 'rgba(91,227,208,0.35)' : colors.line, opacity: closed ? 0.82 : 1 }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: toneColor[tone] }} />
        <View style={{ paddingVertical: 14, paddingLeft: 17, paddingRight: 14, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <SeverityBadge inc={inc} size={36} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="monoSmall" color={colors.t3} style={{ letterSpacing: 0.5 }}>
                <T v="monoSmall" color={colors.t2} style={{ fontFamily: 'GeistMono_600SemiBold' }}>{inc.id}</T>
                {'  ·  '}
                {formatDuration(Math.max(0, simTime - inc.opened_at_s))}
                {closed ? ' total' : ' open'}
              </T>
              <T v="headline" style={{ fontSize: 15.5, lineHeight: 20 }} numberOfLines={2}>
                {inc.title}
              </T>
            </View>
            <ChevronRight size={17} color={colors.t4} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Chip tone={approval ? 'accent' : inc.status === 'escalated' ? 'critical' : closed ? 'nominal' : 'neutral'} sm leading={!closed ? <Dot tone={approval ? 'accent' : 'nominal'} pulse size={6} /> : undefined}>
              {approval ? 'Needs approval' : INCIDENT_STATUS_LABEL[inc.status]}
            </Chip>
            {inc.attempts > 0 && (
              <Chip tone="warning" sm>
                attempt {inc.attempts + 1}
              </Chip>
            )}
          </View>
          <Stepper inc={inc} compact />
        </View>
      </View>
    </PressableScale>
  );
}
