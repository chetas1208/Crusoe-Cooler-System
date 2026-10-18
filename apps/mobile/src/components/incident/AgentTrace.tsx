import { memo, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Ban, Check, ChevronDown, CircleDashed, Cpu, ShieldCheck, Wrench, X , Network } from 'lucide-react-native';
import { formatSimClock, labelOfId, roleLabel } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import type { AgentRole, AgentTask, ToolCall } from '@loopkeeper/core/contracts';
import { alpha, colors, toneColor, type Tone } from '@/theme';
import { haptic } from '@/lib/haptics';
import { Chip, Dot, EmptyState, PressableScale, Section, Segmented, T } from '@/components/ui';
import { useIncidentTasks } from '@/hooks/useTasks';
import { JsonBlock } from './JsonBlock';

const LANE: Record<AgentRole, string> = { sentinel: colors.sentinel, inpipe: colors.inpipe, outrig: colors.outrig };
const SUB: Record<AgentRole, string> = { sentinel: 'Supervisor', inpipe: 'Internal crawler', outrig: 'External robot' };

function statusTone(t: AgentTask): Tone {
  switch (t.status) {
    case 'verified':
      return 'nominal';
    case 'rejected':
    case 'failed':
      return 'critical';
    case 'blocked':
      return 'watch';
    case 'working':
      return t.role;
    case 'completed':
      return 'nominal';
    default:
      return 'isolated';
  }
}

function StatusGlyph({ t, size = 26 }: { t: AgentTask; size?: number }) {
  const tone = statusTone(t);
  const c = toneColor[tone];
  const common = { size: size * 0.5, color: c, strokeWidth: 2.6 } as const;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.bg, borderWidth: 2, borderColor: alpha(c, t.status === 'queued' ? 0.35 : 0.9), alignItems: 'center', justifyContent: 'center' }}>
      {t.status === 'working' ? <Dot tone={t.role} pulse size={8} /> : t.status === 'verified' ? <ShieldCheck {...common} /> : t.status === 'completed' ? <Check {...common} /> : t.status === 'rejected' || t.status === 'failed' ? <X {...common} /> : t.status === 'blocked' ? <Ban {...common} /> : <CircleDashed {...common} />}
    </View>
  );
}

export function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const c = call.status === 'ok' ? colors.nominal : call.status === 'error' || call.status === 'rejected' ? colors.critical : colors.watch;
  return (
    <View style={{ borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
      <PressableScale
        scaleTo={0.99}
        onPress={() => {
          haptic.select();
          setOpen((o) => !o);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 10 }}
      >
        <Wrench size={12} color={c} strokeWidth={2.2} />
        <T v="mono" color={colors.t1} style={{ flex: 1, fontFamily: 'GeistMono_600SemiBold', fontSize: 12 }} numberOfLines={1}>
          {call.name}
        </T>
        <T v="monoSmall" color={c}>
          {call.status}
        </T>
        {call.latency_ms !== undefined ? (
          <T v="monoSmall" color={colors.t4}>
            {call.latency_ms} ms
          </T>
        ) : null}
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDown size={14} color={colors.t3} />
        </View>
      </PressableScale>
      {open && (
        <Animated.View entering={FadeIn.duration(160)} style={{ gap: 10, paddingHorizontal: 10, paddingBottom: 10 }}>
          <JsonBlock label="Input" value={call.input} />
          {call.output !== undefined ? <JsonBlock label="Output" value={call.output} /> : <T v="caption" color={colors.t3}>No output yet — call still running.</T>}
        </Animated.View>
      )}
    </View>
  );
}

export const TaskNode = memo(function TaskNode({ t, depth, last, onFocus }: { t: AgentTask; depth: number; last: boolean; onFocus?: (id: string) => void }) {
  const [open, setOpen] = useState(t.status === 'working');
  const robots = useWorld((s) => s.robots);
  const lane = LANE[t.role];
  const indent = Math.min(depth, 2) * 14;
  return (
    <Animated.View layout={LinearTransition.springify().damping(26)} style={{ flexDirection: 'row', gap: 12, marginLeft: indent }}>
      <View style={{ alignItems: 'center', width: 26 }}>
        <StatusGlyph t={t} />
        {!last && <View style={{ flex: 1, width: 2, marginTop: 2, borderRadius: 1, backgroundColor: alpha(lane, 0.28), minHeight: 14 }} />}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 14 }}>
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: open ? alpha(lane, 0.32) : colors.line, overflow: 'hidden' }}>
          <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: lane }} />
          <PressableScale
            scaleTo={0.992}
            onPress={() => {
              haptic.select();
              setOpen((o) => !o);
            }}
            style={{ paddingVertical: 12, paddingLeft: 15, paddingRight: 12, gap: 7 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T v="micro" color={lane} style={{ fontFamily: 'Geist_700Bold', letterSpacing: 0.7 }}>
                {roleLabel(t.role)}
              </T>
              <T v="monoSmall" color={colors.t4} numberOfLines={1} style={{ flex: 1 }}>
                {t.kind} · {formatSimClock(t.started_tick * 0.5).slice(3)}
              </T>
              {t.tool_calls.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Wrench size={10} color={colors.t3} />
                  <T v="monoSmall" color={colors.t3}>
                    {t.tool_calls.length}
                  </T>
                </View>
              )}
              <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
                <ChevronDown size={14} color={colors.t3} />
              </View>
            </View>
            <T v="headline" style={{ fontSize: 14.5, lineHeight: 20 }}>
              {t.title}
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {t.outcome ? (
                <Chip tone={t.outcome.ok ? 'nominal' : 'critical'} sm>
                  {t.outcome.label}
                </Chip>
              ) : (
                <Chip tone={t.status === 'working' ? t.role : 'neutral'} sm leading={t.status === 'working' ? <Dot tone={t.role} pulse size={6} /> : undefined}>
                  {t.status === 'working' ? 'working…' : t.status}
                </Chip>
              )}
            </View>
          </PressableScale>

          {open && (
            <Animated.View entering={FadeIn.duration(180)} style={{ paddingLeft: 15, paddingRight: 12, paddingBottom: 14, gap: 14 }}>
              <View style={{ gap: 5 }}>
                <T v="eyebrow" style={{ fontSize: 9.5 }}>Question</T>
                <T v="callout" color={colors.t1}>{t.question}</T>
              </View>
              {t.summary ? (
                <View style={{ gap: 5 }}>
                  <T v="eyebrow" style={{ fontSize: 9.5 }}>
                    Thought summary <T v="micro" color={colors.t4} style={{ textTransform: 'none', letterSpacing: 0 }}>· not chain-of-thought</T>
                  </T>
                  <T v="callout" color={colors.t2}>{t.summary}</T>
                </View>
              ) : null}

              <View style={{ gap: 7 }}>
                <T v="eyebrow" style={{ fontSize: 9.5 }}>Model</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <Chip sm icon={Cpu} tone={t.model.provider === 'crusoe' ? 'nominal' : t.model.provider === 'mock' ? 'sentinel' : 'neutral'} mono>
                    {t.model.provider} · {t.model.model_id}
                  </Chip>
                  {t.model.fallback ? <Chip sm tone="warning">deterministic fallback</Chip> : null}
                  {t.model.latency_ms !== undefined ? <Chip sm mono>{t.model.latency_ms} ms</Chip> : null}
                  {t.model.tokens_in !== undefined ? <Chip sm mono>{t.model.tokens_in}↓ {t.model.tokens_out}↑ tok</Chip> : null}
                </View>
              </View>

              {t.tool_calls.length > 0 && (
                <View style={{ gap: 8 }}>
                  <T v="eyebrow" style={{ fontSize: 9.5 }}>Tool calls · {t.tool_calls.length}</T>
                  {t.tool_calls.map((c) => (
                    <ToolCallRow key={c.id} call={c} />
                  ))}
                </View>
              )}

              {(t.asset_ids.length > 0 || t.robot_id) && (
                <View style={{ gap: 7 }}>
                  <T v="eyebrow" style={{ fontSize: 9.5 }}>Hardware</T>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {[...(t.robot_id ? [t.robot_id] : []), ...t.asset_ids].map((id) => (
                      <PressableScale key={id} onPress={() => onFocus?.(id)} scaleTo={0.94}>
                        <Chip sm mono tone={robots[id]?.class ?? 'neutral'}>{labelOfId(id)}</Chip>
                      </PressableScale>
                    ))}
                  </View>
                </View>
              )}
            </Animated.View>
          )}
        </View>
      </View>
    </Animated.View>
  );
});

type Filter = 'all' | AgentRole;

/** Agent trace: SENTINEL / INPIPE / OUTRIG tasks as a vertical, causal timeline with inspectable tool calls. */
export function AgentTrace({ incidentId, onFocusEntity }: { incidentId: string; onFocusEntity?: (id: string) => void }) {
  const tasks = useIncidentTasks(incidentId);
  const [filter, setFilter] = useState<Filter>('all');
  const calls = tasks.reduce((n, t) => n + t.tool_calls.length, 0);
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.role === filter);
  const count = (r: AgentRole) => tasks.filter((t) => t.role === r).length;
  return (
    <Section
      title="Agent trace"
      right={
        <T v="monoSmall" color={colors.t3}>
          {tasks.length} tasks · {calls} tool calls
        </T>
      }
    >
      {tasks.length === 0 ? (
        <EmptyState icon={Network} tone={colors.sentinel} title="No agent activity yet" body="The trace appears as SENTINEL delegates work. Nothing is mocked here — an empty trace means no task has started." />
      ) : (
        <>
          <Segmented<Filter>
            small
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'all', label: 'All', count: tasks.length },
              { id: 'sentinel', label: 'SENTINEL', count: count('sentinel') },
              { id: 'inpipe', label: 'INPIPE', count: count('inpipe') },
              { id: 'outrig', label: 'OUTRIG', count: count('outrig') },
            ]}
          />
          <View style={{ marginTop: 6 }}>
            {shown.map((t, i) => (
              <TaskNode key={t.id} t={t} depth={filter === 'all' ? t.depth : 0} last={i === shown.length - 1} onFocus={onFocusEntity} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 14, marginTop: 4 }}>
            {(['sentinel', 'inpipe', 'outrig'] as AgentRole[]).map((r) => (
              <View key={r} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: LANE[r] }} />
                <T v="micro" color={colors.t3}>
                  {roleLabel(r)} · {SUB[r]}
                </T>
              </View>
            ))}
          </View>
        </>
      )}
    </Section>
  );
}
