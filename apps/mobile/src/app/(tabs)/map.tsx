import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MousePointerClick } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { useTabBarHeight } from '@/components/TabBar';
import { Section, Segmented, T } from '@/components/ui';
import { TacticalMap } from '@/features/map/TacticalMap';
import { Map3D } from '@/features/map/Map3D';
import { Roster } from '@/features/map/Roster';
import { ControlSurface } from '@/features/map/ControlSurface';
import { useMapSel } from '@/features/map/store';
import { useDriveSafety } from '@/features/map/useDriveSafety';

/**
 * The map stays pinned above the scrolling roster / control surface, so the ghost or the robot you are driving is
 * always in view while your thumbs are on the pad.
 */
export default function MapScreen() {
  useDriveSafety();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const tabH = useTabBarHeight();
  const { height: winH } = useWindowDimensions();
  const view = useMapSel((s) => s.view);
  const setView = useMapSel((s) => s.setView);
  const selected = useMapSel((s) => s.selectedId);
  const robot = useWorld((s) => (selected ? s.robots[selected] : undefined));
  const native = Platform.OS !== 'web';
  const mapH = Math.round(Math.min(330, Math.max(210, winH * 0.31)));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T v="title" style={{ fontSize: 24 }}>
            Map
          </T>
          {native ? (
            <Segmented<'2d' | '3d'>
              small
              value={view}
              onChange={setView}
              style={{ width: 190 }}
              items={[
                { id: '2d', label: '2D tactical' },
                { id: '3d', label: '3D scene' },
              ]}
            />
          ) : null}
        </View>
        {view === '3d' && native ? <Map3D height={mapH} active={focused} /> : <TacticalMap height={mapH} />}
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: tabH + 28, gap: 18 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {robot ? (
          <ControlSurface robot={robot} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
            <MousePointerClick size={18} color={colors.t3} />
            <T v="callout" color={colors.t2} style={{ flex: 1 }}>
              Select a robot on the map or in the roster to preview a drive or take lease-based control.
            </T>
          </View>
        )}
        <Section title="Roster">
          <Roster />
        </Section>
      </ScrollView>
    </View>
  );
}
