import { ScrollView, View } from 'react-native';
import { useView } from '@loopkeeper/scene';
import { alpha, colors } from '@/theme';
import { MOBILE_PRESETS, PRESET_LABEL, applyCameraPreset, type PresetId } from '@/lib/camera';
import { haptic } from '@/lib/haptics';
import { Glass, PressableScale, T } from '@/components/ui';

const IDS: PresetId[] = ['whole', 'plant', 'zone_a', 'zone_b'];

/** Camera preset chips — highlights the preset the camera goal currently matches. */
export function PresetChips() {
  const cam = useView((s) => s.cam);
  const follow = useView((s) => s.followRobotId);
  const selected = useView((s) => s.selectedId);
  const mode = useView((s) => s.mode);
  const az = (a: number, b: number) => Math.abs(((((a - b + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI);
  const active =
    !follow && !selected
      ? IDS.find((id) => Math.abs(MOBILE_PRESETS[id].target[0] - cam.target[0]) < 0.05 && Math.abs(MOBILE_PRESETS[id].distance - cam.distance) < 0.4 && az(MOBILE_PRESETS[id].azimuth, cam.azimuth) < 0.12)
      : undefined;
  if (mode === 'pipe') return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {IDS.map((id) => {
        const on = id === active;
        return (
          <PressableScale
            key={id}
            scaleTo={0.93}
            onPress={() => {
              haptic.select();
              applyCameraPreset(id);
            }}
          >
            <Glass radius={999} dense intensity={50}>
              <View style={{ height: 34, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? alpha(colors.accent, 0.18) : 'transparent' }}>
                <T v="caption" color={on ? colors.accent : colors.t1} style={{ fontSize: 13, fontFamily: on ? 'Geist_600SemiBold' : 'Geist_500Medium' }}>
                  {PRESET_LABEL[id]}
                </T>
              </View>
            </Glass>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
