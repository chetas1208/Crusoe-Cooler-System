import { useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, { LinearTransition, FadeIn } from 'react-native-reanimated';
import { ShieldCheck } from 'lucide-react-native';
import { colors } from '@/theme';
import { openIncident } from '@/lib/nav';
import { ScreenScroll } from '@/components/ScreenScroll';
import { useIncidents } from '@/hooks/useIncidents';
import { IncidentRow } from '@/components/incident/IncidentRow';
import { EmptyState, Segmented, T } from '@/components/ui';

type Filter = 'open' | 'resolved' | 'all';

export default function IncidentsScreen() {
  const all = useIncidents();
  const [filter, setFilter] = useState<Filter>('open');
  const open = useMemo(() => all.filter((i) => !i.closed_tick), [all]);
  const closed = useMemo(() => all.filter((i) => i.closed_tick), [all]);
  const shown = filter === 'open' ? open : filter === 'resolved' ? closed : all;
  return (
    <ScreenScroll title="Incidents" contentStyle={{ paddingHorizontal: 16, gap: 14 }}>
      <T v="callout" color={colors.t3}>
        Faults develop in the simulated facility; SENTINEL, INPIPE and OUTRIG investigate, repair, and an independent verifier checks the physics before anything closes.
      </T>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        items={[
          { id: 'open', label: 'Open', count: open.length },
          { id: 'resolved', label: 'Resolved', count: closed.length },
          { id: 'all', label: 'All', count: all.length },
        ]}
      />
      {shown.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={filter === 'resolved' ? 'Nothing resolved yet' : 'No incidents'}
          body={filter === 'resolved' ? 'Closed incidents, with their verification results, collect here.' : 'The plant is nominal. New incidents appear here the moment SENTINEL opens one — nothing on this screen is mocked.'}
        />
      ) : (
        <View style={{ gap: 12 }}>
          {shown.map((i) => (
            <Animated.View key={i.id} layout={LinearTransition.springify().damping(26)} entering={FadeIn.duration(220)}>
              <IncidentRow inc={i} onPress={() => openIncident(i.id)} />
            </Animated.View>
          ))}
        </View>
      )}
    </ScreenScroll>
  );
}
