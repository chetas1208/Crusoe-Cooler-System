import { View } from 'react-native';
import { Check, CircleAlert, TriangleAlert } from 'lucide-react-native';
import { CAUSE_LABEL, INCIDENT_STATUS_LABEL, formatDuration } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import { alpha, colors, toneColor } from '@/theme';
import { useIncidentTasks } from '@/hooks/useTasks';
import { incidentTone } from '@/hooks/useIncidents';
import { Chip, Dot, T } from '@/components/ui';

export function SeverityBadge({ inc, size = 38 }: { inc: Incident; size?: number }) {
  const tone = incidentTone(inc);
  const c = toneColor[tone];
  const Icon = inc.closed_tick ? Check : inc.severity === 'critical' || inc.status === 'escalated' ? TriangleAlert : CircleAlert;
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: alpha(c, 0.14), borderWidth: 1, borderColor: alpha(c, 0.3), alignItems: 'center', justifyContent: 'center' }}>
      <Icon size={size * 0.48} color={c} strokeWidth={2.4} />
    </View>
  );
}

export function IncidentHeader({ inc, large }: { inc: Incident; large?: boolean }) {
  const simTime = useWorld((s) => s.simTimeS);
  const tasks = useIncidentTasks(inc.id);
  const working = !inc.closed_tick && tasks.some((t) => t.status === 'working');
  const tone = incidentTone(inc);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SeverityBadge inc={inc} size={large ? 44 : 38} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="monoSmall" color={colors.t3} style={{ letterSpacing: 0.6 }}>
            <T v="monoSmall" color={colors.t2} style={{ fontFamily: 'GeistMono_600SemiBold' }}>{inc.id}</T>
            {'  ·  '}
            {formatDuration(Math.max(0, simTime - inc.opened_at_s))}
            {inc.closed_tick ? ' total' : ' open'}
          </T>
          <T v="headline" style={{ fontSize: large ? 19 : 16, lineHeight: large ? 24 : 21, letterSpacing: -0.3 }} numberOfLines={large ? 3 : 2}>
            {inc.title}
          </T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip tone={inc.status === 'escalated' ? 'critical' : inc.closed_tick ? 'nominal' : 'accent'} sm leading={<Dot tone={inc.closed_tick ? 'nominal' : inc.status === 'escalated' ? 'critical' : 'accent'} pulse={working} size={6} />}>
          {INCIDENT_STATUS_LABEL[inc.status]}
        </Chip>
        <Chip sm>{CAUSE_LABEL[inc.cause]}</Chip>
        <Chip sm tone={tone === 'nominal' || tone === 'isolated' ? 'neutral' : tone}>
          {inc.severity}
        </Chip>
        {inc.attempts > 0 && (
          <Chip tone="warning" sm>
            attempt {inc.attempts + 1}
          </Chip>
        )}
      </View>
    </View>
  );
}
