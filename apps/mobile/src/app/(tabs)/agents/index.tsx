import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ChevronRight, Cpu, Wrench } from 'lucide-react-native';
import type { AgentRole } from '@loopkeeper/core/contracts';
import { labelOfId } from '@loopkeeper/core';
import { alpha, colors, toneColor } from '@/theme';
import { openAgent } from '@/lib/nav';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Chip, Dot, PressableScale, Segmented, T } from '@/components/ui';
import { useAgents, type AgentEntry } from '@/features/agents/useAgents';
import { FAMILY_LABEL, FAMILY_SUB, type StatusGroup } from '@/features/agents/status';

type Fam = AgentRole;
type Grp = 'all' | StatusGroup;

function Row({ a, last }: { a: AgentEntry; last: boolean }) {
  const calls = a.kind === 'robot' ? a.tasks.reduce((n, t) => n + t.tool_calls.length, 0) : 0;
  const accent = a.role === 'sentinel' ? colors.sentinel : a.role === 'inpipe' ? colors.inpipe : colors.outrig;
  return (
    <PressableScale scaleTo={0.99} onPress={() => openAgent(a.id)} accessibilityRole="button" accessibilityLabel={`${a.kind === 'supervisor' ? a.id : labelOfId(a.id)}, ${a.status.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.line }}>
      <View style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, backgroundColor: alpha(accent, 0.7) }} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="headline" style={{ fontSize: 15 }}>
            {a.kind === 'supervisor' ? a.id : labelOfId(a.id)}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Dot tone={a.status.tone} size={6} pulse={a.status.group === 'working' && a.status.tone !== 'isolated'} />
            <T v="caption" color={a.status.group === 'blocked' ? colors.warning : colors.t2} numberOfLines={1}>
              {a.status.label}
            </T>
          </View>
        </View>
        <T v="caption" color={colors.t3} numberOfLines={1}>
          {a.sub}
        </T>
      </View>
      {a.kind === 'robot' ? (
        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Cpu size={11} color={colors.t3} />
            <T v="monoSmall" color={colors.t2}>
              {a.tasks.length}
            </T>
            <Wrench size={11} color={colors.t3} />
            <T v="monoSmall" color={colors.t2}>
              {calls}
            </T>
          </View>
        </View>
      ) : null}
      <ChevronRight size={16} color={colors.t4} />
    </PressableScale>
  );
}

export default function AgentsList() {
  const { entries, loaded } = useAgents();
  const [fam, setFam] = useState<Fam>('sentinel');
  const [grp, setGrp] = useState<Grp>('all');
  const count = (r: Fam) => entries.filter((e) => e.role === r).length;
  const inFam = useMemo(() => entries.filter((e) => e.role === fam), [entries, fam]);
  const shown = useMemo(() => inFam.filter((e) => grp === 'all' || e.status.group === grp), [inFam, grp]);
  const gcount = (g: StatusGroup) => inFam.filter((e) => e.status.group === g).length;

  return (
    <ScreenScroll title="Agents" contentStyle={{ paddingHorizontal: 16, gap: 14 }}>
      <Segmented<Fam>
        value={fam}
        onChange={(f) => {
          setFam(f);
          setGrp('all');
        }}
        items={(['sentinel', 'inpipe', 'outrig'] as Fam[]).map((r) => ({ id: r, label: FAMILY_LABEL[r], count: count(r) }))}
      />
      <T v="caption" color={toneColor[fam]} style={{ marginTop: -4 }}>
        {FAMILY_SUB[fam]}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['all', 'working', 'blocked', 'idle', 'done'] as Grp[]).map((g) => (
          <PressableScale key={g} scaleTo={0.95} onPress={() => setGrp(g)} accessibilityRole="button" accessibilityState={{ selected: grp === g }}>
            <Chip tone={grp === g ? 'accent' : 'neutral'}>{g === 'all' ? `All ${inFam.length}` : `${g[0].toUpperCase()}${g.slice(1)} ${gcount(g)}`}</Chip>
          </PressableScale>
        ))}
      </View>
      {shown.length === 0 ? (
        <T v="callout" color={colors.t3}>
          {fam === 'sentinel' && !loaded ? 'Loading supervisors…' : fam === 'sentinel' && inFam.length === 0 ? 'This backend reports no SENTINEL supervisors (GET /agents/graph).' : inFam.length === 0 ? 'No robots reported by this backend.' : 'No agent in this state.'}
        </T>
      ) : (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
          {shown.map((a, i) => (
            <Row key={a.id} a={a} last={i === shown.length - 1} />
          ))}
        </View>
      )}
    </ScreenScroll>
  );
}
