import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SearchX, ShieldCheck, ShieldX } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { ROBOT_MODE_LABEL, labelOfId } from '@loopkeeper/core';
import { alpha, colors } from '@/theme';
import { openIncident, showRobotOnMap } from '@/lib/nav';
import { ScreenScroll } from '@/components/ScreenScroll';
import { TaskNode, ToolCallRow } from '@/components/incident/AgentTrace';
import { VerificationBlock } from '@/components/incident/VerificationBlock';
import { Button, Chip, Dot, EmptyState, PressableScale, Segmented, T } from '@/components/ui';
import { useAgents } from '@/features/agents/useAgents';
import { deriveTaskStatus } from '@/features/agents/status';

type Tab = 'tasks' | 'tools' | 'verdicts';

export default function AgentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { entries } = useAgents();
  const incidents = useWorld((s) => s.incidents);
  const agent = entries.find((e) => e.id === id);
  const [tab, setTab] = useState<Tab>('tasks');

  const calls = useMemo(() => (agent ? agent.tasks.flatMap((t) => t.tool_calls.map((c) => ({ c, t }))).sort((a, b) => b.c.tick - a.c.tick) : []), [agent]);
  const verdictIncidents = useMemo(() => {
    if (!agent) return [];
    const ids = [...new Set(agent.tasks.map((t) => t.incident_id))];
    return ids.map((i) => incidents[i]).filter(Boolean);
  }, [agent, incidents]);
  const taskVerdicts = useMemo(() => (agent ? agent.tasks.filter((t) => t.outcome || t.status === 'verified' || t.status === 'rejected') : []), [agent]);

  if (!agent) {
    return (
      <ScreenScroll title={id ?? 'Agent'} variant="detail" backLabel="Agents">
        <EmptyState icon={SearchX} tone={colors.t3} title="Agent not found" body="It is not in the backend's current roster. Nothing is shown in its place." />
      </ScreenScroll>
    );
  }
  const robot = agent.robot;
  const lane = agent.role === 'sentinel' ? colors.sentinel : agent.role === 'inpipe' ? colors.inpipe : colors.outrig;
  const working = agent.tasks.filter((t) => t.status === 'working').length;

  return (
    <ScreenScroll title={agent.kind === 'supervisor' ? agent.id : labelOfId(agent.id)} variant="detail" backLabel="Agents" contentStyle={{ paddingHorizontal: 16, gap: 18 }}>
      <View style={{ gap: 10, padding: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: alpha(lane, 0.4) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip tone={agent.role}>{agent.role.toUpperCase()}</Chip>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Dot tone={agent.status.tone} size={7} pulse={agent.status.group === 'working' && agent.status.tone !== 'isolated'} />
            <T v="callout" color={colors.t1}>
              {agent.status.label}
            </T>
          </View>
        </View>
        <T v="callout" color={colors.t2}>
          {agent.sub}
        </T>
        {robot ? (
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="eyebrow" style={{ fontSize: 9 }}>
                Mode
              </T>
              <T v="mono">{ROBOT_MODE_LABEL[robot.mode]}</T>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="eyebrow" style={{ fontSize: 9 }}>
                Battery
              </T>
              <T v="mono">{Math.round(robot.battery_pct)}%</T>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="eyebrow" style={{ fontSize: 9 }}>
                Control
              </T>
              <T v="mono">{robot.control?.authority ?? '—'}</T>
            </View>
          </View>
        ) : (
          <T v="caption" color={colors.t3}>
            The backend does not attribute tasks to individual supervisor seats, so this shows every SENTINEL-role task.
          </T>
        )}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip sm mono>
            {agent.tasks.length} tasks
          </Chip>
          <Chip sm mono>
            {working} working
          </Chip>
          <Chip sm mono>
            {calls.length} tool calls
          </Chip>
        </View>
        {robot ? <Button label="Show on map" size="sm" onPress={() => showRobotOnMap(robot.id)} /> : null}
      </View>

      <Segmented<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'tasks', label: 'Tasks', count: agent.tasks.length },
          { id: 'tools', label: 'Tool calls', count: calls.length },
          { id: 'verdicts', label: 'Verdicts', count: verdictIncidents.length },
        ]}
      />

      {tab === 'tasks' ? (
        agent.tasks.length === 0 ? (
          <T v="callout" color={colors.t3}>
            No task has been assigned to this agent. Nothing is mocked: an empty list means none started.
          </T>
        ) : (
          <View>
            {agent.tasks.map((t, i) => (
              <TaskNode key={t.id} t={t} depth={0} last={i === agent.tasks.length - 1} onFocus={showRobotOnMap} />
            ))}
          </View>
        )
      ) : tab === 'tools' ? (
        calls.length === 0 ? (
          <T v="callout" color={colors.t3}>
            No tool calls recorded for this agent.
          </T>
        ) : (
          <View style={{ gap: 8 }}>
            {calls.map(({ c, t }) => (
              <View key={c.id} style={{ gap: 4 }}>
                <T v="monoSmall" color={colors.t4} numberOfLines={1}>
                  {t.title}
                </T>
                <ToolCallRow call={c} />
              </View>
            ))}
          </View>
        )
      ) : (
        <View style={{ gap: 16 }}>
          {taskVerdicts.length > 0 && (
            <View style={{ gap: 8 }}>
              <T v="eyebrow">Task outcomes</T>
              {taskVerdicts.map((t) => {
                const st = deriveTaskStatus(t, robot);
                const ok = t.outcome ? t.outcome.ok : st.verified;
                const Icon = ok ? ShieldCheck : ShieldX;
                return (
                  <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
                    <Icon size={18} color={ok ? colors.nominal : colors.critical} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T v="callout" numberOfLines={2}>
                        {t.title}
                      </T>
                      <T v="caption" color={ok ? colors.nominal : colors.critical}>
                        {t.outcome?.label ?? st.label}
                      </T>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
          {verdictIncidents.length === 0 && taskVerdicts.length === 0 ? (
            <T v="callout" color={colors.t3}>
              No verification or outcome yet. The independent verifier records a verdict only after a repair.
            </T>
          ) : null}
          {verdictIncidents.map((inc) => (
            <View key={inc.id} style={{ gap: 8 }}>
              <PressableScale onPress={() => openIncident(inc.id)} scaleTo={0.99}>
                <T v="eyebrow" color={colors.accent}>
                  {inc.id} · {inc.title}
                </T>
              </PressableScale>
              {inc.verification ? (
                <VerificationBlock inc={inc} />
              ) : (
                <T v="caption" color={colors.t3}>
                  No independent verification recorded for this incident yet.
                </T>
              )}
            </View>
          ))}
        </View>
      )}
    </ScreenScroll>
  );
}
