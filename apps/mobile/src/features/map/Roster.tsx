import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { Battery, Hand } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { ROBOT_MODE_LABEL, labelOfId } from '@loopkeeper/core';
import type { Robot } from '@loopkeeper/core/contracts';
import { alpha, colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { Chip, PressableScale, Segmented, T } from '@/components/ui';
import { useMapSel } from './store';

type Cls = 'all' | 'inpipe' | 'outrig';
const MODE_TONE = (r: Robot) => (r.mode === 'FAILED' || r.mode === 'BLOCKED' || r.mode === 'SAFE_HOLD' || r.mode === 'ABORTED' ? 'critical' : r.mode === 'NEEDS_CHARGE' ? 'warning' : r.mode === 'DOCKED' || r.mode === 'IDLE' ? 'neutral' : r.class);

export function Roster() {
  const robots = useWorld(useShallow((s) => Object.values(s.robots)));
  const missions = useWorld((s) => s.missions);
  const selected = useMapSel((s) => s.selectedId);
  const select = useMapSel((s) => s.select);
  const [cls, setCls] = useState<Cls>('all');
  const [q, setQ] = useState('');
  const counts = { inpipe: robots.filter((r) => r.class === 'inpipe').length, outrig: robots.filter((r) => r.class === 'outrig').length };
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return robots
      .filter((r) => (cls === 'all' || r.class === cls) && (!needle || `${r.id} ${r.name} ${r.mode}`.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.mode !== 'DOCKED' && b.mode !== 'IDLE') - Number(a.mode !== 'DOCKED' && a.mode !== 'IDLE') || a.id.localeCompare(b.id));
  }, [robots, cls, q]);

  return (
    <View style={{ gap: 10 }}>
      <Segmented<Cls>
        small
        value={cls}
        onChange={setCls}
        items={[
          { id: 'all', label: 'All', count: robots.length },
          { id: 'inpipe', label: 'Internal', count: counts.inpipe },
          { id: 'outrig', label: 'External', count: counts.outrig },
        ]}
      />
      <TextInput value={q} onChangeText={setQ} placeholder="Find a robot or mode" placeholderTextColor={colors.t4} accessibilityLabel="Find a robot" autoCapitalize="none" autoCorrect={false} style={{ height: 38, borderRadius: 11, paddingHorizontal: 12, color: colors.t1, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.line, fontFamily: 'Geist_500Medium', fontSize: 13.5 }} />
      {rows.length === 0 ? (
        <T v="callout" color={colors.t3}>
          {robots.length === 0 ? 'No robots reported by this backend.' : 'No robot matches.'}
        </T>
      ) : (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
          {rows.map((r, i) => {
            const m = r.mission_id ? missions[r.mission_id] : undefined;
            const on = r.id === selected;
            return (
              <PressableScale
                key={r.id}
                scaleTo={0.99}
                accessibilityRole="button"
                accessibilityLabel={`${labelOfId(r.id)}, ${ROBOT_MODE_LABEL[r.mode]}`}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  haptic.select();
                  select(on ? null : r.id);
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 13, backgroundColor: on ? alpha(colors.accent, 0.1) : 'transparent', borderBottomWidth: i === rows.length - 1 ? 0 : 1, borderBottomColor: colors.line }}
              >
                <View style={{ width: 10, height: 10, borderRadius: r.class === 'inpipe' ? 2 : 5, backgroundColor: r.class === 'inpipe' ? colors.inpipe : colors.outrig, transform: [{ rotate: r.class === 'inpipe' ? '45deg' : '0deg' }] }} />
                <View style={{ flex: 1, gap: 1 }}>
                  <T v="headline" style={{ fontSize: 14.5 }}>
                    {labelOfId(r.id)}
                  </T>
                  <T v="caption" color={colors.t3} numberOfLines={1}>
                    {m ? m.title : r.mode === 'DOCKED' ? `Docked at ${labelOfId(r.home_id)}` : ROBOT_MODE_LABEL[r.mode]}
                  </T>
                </View>
                {r.control?.authority === 'HUMAN' ? <Hand size={14} color={colors.watch} /> : null}
                <Chip sm tone={MODE_TONE(r)}>
                  {ROBOT_MODE_LABEL[r.mode]}
                </Chip>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, width: 44, justifyContent: 'flex-end' }}>
                  <Battery size={12} color={r.battery_pct < 20 ? colors.warning : colors.t3} />
                  <T v="monoSmall" color={colors.t2}>
                    {Math.round(r.battery_pct)}
                  </T>
                </View>
              </PressableScale>
            );
          })}
        </View>
      )}
    </View>
  );
}
