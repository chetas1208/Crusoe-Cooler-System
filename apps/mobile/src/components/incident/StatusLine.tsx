import { View } from 'react-native';
import { INCIDENT_STATUS_LABEL, roleLabel } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import { colors, toneColor } from '@/theme';
import { useIncidentTasks } from '@/hooks/useTasks';
import { Dot, T } from '@/components/ui';

/** One plain-language line: what is the system doing about this right now? */
export function useIncidentActivity(inc: Incident) {
  const tasks = useIncidentTasks(inc.id);
  const missions = useWorld((s) => s.missions);
  const working = tasks.filter((t) => t.status === 'working');
  const task = working[working.length - 1];
  const mission = inc.mission_ids.map((id) => missions[id]).find((m) => m && !m.closed_tick);
  const step = mission?.steps.find((s) => s.status === 'active');
  return { task, mission, step, working: working.length };
}

export function StatusLine({ inc }: { inc: Incident }) {
  const { task, step } = useIncidentActivity(inc);
  if (inc.closed_tick) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Dot tone={inc.status === 'dismissed' ? 'isolated' : 'nominal'} size={6} />
        <T v="callout" color={colors.t2} style={{ flex: 1 }}>
          {inc.close_reason ?? INCIDENT_STATUS_LABEL[inc.status]}
        </T>
      </View>
    );
  }
  const text = step ? `${step.label}…` : task ? task.title : INCIDENT_STATUS_LABEL[inc.status];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      <Dot tone={task?.role ?? 'accent'} pulse size={6} />
      {task ? (
        <T v="micro" color={toneColor[task.role]} style={{ fontFamily: 'Geist_600SemiBold', letterSpacing: 0.5 }}>
          {roleLabel(task.role)}
        </T>
      ) : null}
      <T v="callout" color={colors.t1} style={{ flex: 1 }} numberOfLines={1}>
        {text}
      </T>
    </View>
  );
}
