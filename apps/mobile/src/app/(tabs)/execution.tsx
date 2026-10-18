import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { colors } from '@/theme';
import { liveRunIdOf, useRuns } from '@/hooks/useRuns';
import { ScreenScroll } from '@/components/ScreenScroll';
import { Chip, PressableScale, T } from '@/components/ui';
import { ScenarioPanel } from '@/features/execution/ScenarioPanel';
import { CommsPanel } from '@/features/execution/CommsPanel';
import { DodPanel } from '@/features/execution/DodPanel';
import { TeamPanel } from '@/features/execution/TeamPanel';
import { RunPanel } from '@/features/execution/RunPanel';
import { useComms } from '@/features/comms/store';

type Panel = 'scenario' | 'comms' | 'dod' | 'team' | 'run';
const PANELS: { id: Panel; label: string }[] = [
  { id: 'scenario', label: 'Scenario' },
  { id: 'comms', label: 'Comms' },
  { id: 'dod', label: 'DoD' },
  { id: 'team', label: 'Team' },
  { id: 'run', label: 'Run' },
];

export default function Execution() {
  const [panel, setPanel] = useState<Panel>('scenario');
  const target = useRuns(useShallow((s) => ({ id: s.selectedId ?? liveRunIdOf(s.runs), live: (s.selectedId ?? liveRunIdOf(s.runs)) === liveRunIdOf(s.runs) })));
  const unread = useComms((s) => (s.open ? 0 : s.unread));

  return (
    <ScreenScroll title="Execution" contentStyle={{ paddingHorizontal: 16, gap: 16 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -16 }} contentInset={{ left: 16, right: 16 }}>
        <View style={{ width: 8 }} />
        {PANELS.map((p) => (
          <PressableScale key={p.id} scaleTo={0.95} onPress={() => setPanel(p.id)} accessibilityRole="tab" accessibilityState={{ selected: panel === p.id }} accessibilityLabel={p.label}>
            <Chip tone={panel === p.id ? 'accent' : 'neutral'} style={{ height: 34, paddingHorizontal: 15, borderRadius: 17 }}>
              {p.label}
              {p.id === 'comms' && unread > 0 ? ` · ${unread}` : ''}
            </Chip>
          </PressableScale>
        ))}
        <View style={{ width: 8 }} />
      </ScrollView>
      <T v="monoSmall" color={colors.t3} numberOfLines={1} style={{ marginTop: -6 }}>
        Run: {target.id ?? 'none'}
        {target.id && !target.live ? ' (selected, not the live run)' : target.id ? ' (live)' : ''}
      </T>

      {panel === 'scenario' ? <ScenarioPanel onRun={(id) => useRuns.getState().select(id === liveRunIdOf(useRuns.getState().runs) ? null : id)} /> : null}
      {panel === 'comms' ? <CommsPanel /> : null}
      {panel === 'dod' ? <DodPanel /> : null}
      {panel === 'team' ? <TeamPanel /> : null}
      {panel === 'run' ? <RunPanel /> : null}
    </ScreenScroll>
  );
}
