import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Bot } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { ScreenScroll } from '@/components/ScreenScroll';
import { RobotCard } from '@/components/fleet/RobotCard';
import { EmptyState, Segmented, T } from '@/components/ui';

type Kind = 'inpipe' | 'outrig';

export default function FleetScreen() {
  const [kind, setKind] = useState<Kind>('inpipe');
  const robots = useWorld(useShallow((s) => Object.values(s.robots)));
  const internal = useMemo(() => robots.filter((r) => r.class === 'inpipe').sort((a, b) => a.id.localeCompare(b.id)), [robots]);
  const external = useMemo(() => robots.filter((r) => r.class === 'outrig').sort((a, b) => a.id.localeCompare(b.id)), [robots]);
  const shown = kind === 'inpipe' ? internal : external;
  return (
    <ScreenScroll title="Fleet" contentStyle={{ paddingHorizontal: 16, gap: 14 }}>
      <T v="callout" color={colors.t3}>
        Virtual robots in the simulated facility. Poses, batteries and missions are streamed from the simulator — nothing here is animated locally.
      </T>
      <Segmented<Kind>
        value={kind}
        onChange={setKind}
        items={[
          { id: 'inpipe', label: 'Internal', count: internal.length },
          { id: 'outrig', label: 'External', count: external.length },
        ]}
      />
      {shown.length === 0 ? (
        <EmptyState icon={Bot} tone={colors.t3} title="No robots reported" body="The backend has not reported any robots of this class." />
      ) : (
        <View style={{ gap: 14 }}>
          {shown.map((r) => (
            <RobotCard key={r.id} robot={r} />
          ))}
        </View>
      )}
    </ScreenScroll>
  );
}
