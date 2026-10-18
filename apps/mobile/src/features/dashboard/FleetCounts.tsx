import { View } from 'react-native';
import { router } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { useSupervisors } from '@/hooks/useSupervisors';
import { PressableScale, T } from '@/components/ui';

function Count({ n, label, color, onPress }: { n: string; label: string; color: string; onPress: () => void }) {
  return (
    <PressableScale scaleTo={0.97} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${n} ${label}`} style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
      <T v="numLarge" color={color}>
        {n}
      </T>
      <T v="micro" color={colors.t2}>
        {label}
      </T>
    </PressableScale>
  );
}

const ACTIVE = new Set(['ASSIGNED', 'ROUTE_PLANNING', 'TRAVELING', 'INSPECTING', 'WORKING', 'VERIFYING', 'RETURNING']);
const STUCK = new Set(['BLOCKED', 'SAFE_HOLD', 'NEEDS_CHARGE', 'FAILED', 'ABORTED']);

/** Fleet counts as the backend reports them (10 internal INPIPE · 8 external OUTRIG · 5 SENTINEL supervisors). */
export function FleetCounts() {
  const modes = useWorld(useShallow((s) => Object.values(s.robots).map((r) => `${r.class}|${r.mode}`)));
  const sup = useSupervisors();
  const inpipe = modes.filter((m) => m.startsWith('inpipe')).length;
  const outrig = modes.filter((m) => m.startsWith('outrig')).length;
  const working = modes.filter((m) => ACTIVE.has(m.split('|')[1])).length;
  const stuck = modes.filter((m) => STUCK.has(m.split('|')[1])).length;
  const idle = modes.length - working - stuck;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Count n={String(inpipe)} label="internal" color={colors.inpipe} onPress={() => router.navigate('/agents' as never)} />
        <Count n={String(outrig)} label="external" color={colors.outrig} onPress={() => router.navigate('/agents' as never)} />
        <Count n={sup.loaded ? String(sup.list.length) : '…'} label="supervisors" color={colors.sentinel} onPress={() => router.navigate('/agents' as never)} />
      </View>
      <T v="caption" color={colors.t3}>
        {modes.length === 0 ? 'No robots reported by this backend.' : `${working} working · ${idle} idle or docked · ${stuck} blocked or needs charge`}
      </T>
    </View>
  );
}
