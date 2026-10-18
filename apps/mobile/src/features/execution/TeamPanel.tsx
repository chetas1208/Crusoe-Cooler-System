import { View } from 'react-native';
import { alpha, colors, toneColor } from '@/theme';
import { Chip, Meter, T } from '@/components/ui';
import { useDod } from '@/features/dod/store';
import { SEN_ROLES, type TeamTask } from '@/features/dod/types';
import { useDodPolling } from './DodPanel';

const ST_TONE = (s: string) => (s === 'done' ? 'nominal' : s === 'failed' ? 'critical' : s === 'blocked' ? 'warning' : s === 'running' ? 'accent' : s === 'cancelled' ? 'isolated' : 'neutral');
const roleTone = (r: string) => (r === 'inpipe' ? 'inpipe' : r === 'outrig' ? 'outrig' : 'sentinel');

function Task({ t }: { t: TeamTask }) {
  const rt = roleTone(t.role);
  return (
    <View style={{ gap: 5, padding: 12, paddingLeft: 12 + Math.min(t.depth, 3) * 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: toneColor[rt] }} />
        <T v="callout" style={{ flex: 1 }} numberOfLines={2}>
          {t.title}
        </T>
        <Chip sm tone={ST_TONE(t.status)}>
          {t.status}
        </Chip>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip sm tone={rt}>
          {t.role.toUpperCase()}
        </Chip>
        {t.owner ? (
          <Chip sm mono>
            {t.owner}
          </Chip>
        ) : null}
        {t.kind ? (
          <Chip sm mono>
            {t.kind}
          </Chip>
        ) : null}
        {t.tool_calls !== undefined ? (
          <Chip sm mono>
            {t.tool_calls} calls
          </Chip>
        ) : null}
        {t.model?.model_id ? (
          <Chip sm mono tone={t.model.fallback ? 'warning' : 'neutral'}>
            {t.model.provider ? `${t.model.provider} · ` : ''}
            {t.model.model_id}
            {t.model.fallback ? ' · fallback' : ''}
          </Chip>
        ) : null}
      </View>
      {t.budget_limit !== undefined && t.budget_used !== undefined && t.budget_limit > 0 ? (
        <View style={{ gap: 3 }}>
          <Meter value={Math.min(1, t.budget_used / t.budget_limit)} tone={t.budget_used >= t.budget_limit ? 'critical' : 'nominal'} />
          <T v="micro" color={colors.t3}>
            budget {t.budget_used} / {t.budget_limit}
            {t.budget_unit ? ` ${t.budget_unit}` : ''}
          </T>
        </View>
      ) : null}
      {t.warnings.map((w, i) => (
        <T key={i} v="caption" color={colors.warning}>
          {w.kind}: {w.text}
        </T>
      ))}
    </View>
  );
}

/** Team view: the five SENTINEL seats, the incident's task tree with budgets, and loop / drift warnings. */
export function TeamPanel() {
  const runId = useDodPolling();
  const { team, teamLoad, teamError, incidentId } = useDod();
  if (!runId) return <T v="callout" color={colors.t3}>There is no live run to read a team from.</T>;
  if (teamLoad === 'error') return <T v="callout" color={colors.critical}>Could not load the team: {teamError}. Retrying.</T>;
  if (!team) {
    return (
      <T v="callout" color={colors.t3}>
        {teamLoad === 'loading' || teamLoad === 'idle' ? 'Loading the team…' : 'No team graph yet. It is published once SENTINEL opens an incident.'}
      </T>
    );
  }
  const members = team.members.length ? team.members : SEN_ROLES.map((r) => ({ id: r.id, role: 'sentinel', title: r.title, status: undefined as string | undefined }));
  return (
    <View style={{ gap: 14 }}>
      <T v="caption" color={colors.t3}>
        Team for {incidentId ?? 'the incident'}
        {team.members.length ? '' : ' · seat names from the V11 spec (the backend sent none)'}
      </T>
      <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
        {members.map((m, i) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: i === members.length - 1 ? 0 : 1, borderBottomColor: colors.line }}>
            <Chip sm mono tone="sentinel">
              {m.id}
            </Chip>
            <T v="callout" style={{ flex: 1 }} numberOfLines={1}>
              {m.title}
            </T>
            {m.status ? (
              <T v="caption" color={colors.t3}>
                {m.status}
              </T>
            ) : null}
          </View>
        ))}
      </View>
      {team.budgets ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {([['depth', team.budgets.depth_seen, team.budgets.max_depth], ['LLM tasks', team.budgets.llm_tasks, team.budgets.max_llm_tasks], ['plan revisions', team.budgets.plan_revisions, team.budgets.max_plan_revisions]] as const).map(([k, used, max]) => (
            <Chip key={k} tone={max !== null && used !== null && used >= max ? 'warning' : 'neutral'} mono>
              {k} {used ?? '—'}/{max ?? '—'}
            </Chip>
          ))}
          {team.budgets.attempts !== null ? (
            <Chip mono tone="neutral">
              attempts {team.budgets.attempts}
            </Chip>
          ) : null}
        </View>
      ) : null}
      {team.warnings.map((w, i) => (
        <View key={i} style={{ padding: 10, borderRadius: 12, backgroundColor: alpha(colors.warning, 0.09), borderWidth: 1, borderColor: alpha(colors.warning, 0.3) }}>
          <T v="caption" color={colors.warning}>
            {w.kind}: {w.text}
          </T>
        </View>
      ))}
      {team.tasks.length === 0 ? (
        <T v="callout" color={colors.t3}>
          No tasks in this team yet.
        </T>
      ) : (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
          {team.tasks.map((t) => (
            <Task key={t.id} t={t} />
          ))}
        </View>
      )}
    </View>
  );
}
