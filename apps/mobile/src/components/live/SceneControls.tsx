import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Cable, Layers, LocateFixed, Radar, X } from 'lucide-react-native';
import { useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { alpha, colors } from '@/theme';
import { applyCameraPreset } from '@/lib/camera';
import { haptic } from '@/lib/haptics';
import { Glass, PressableScale, T } from '@/components/ui';

function RoundButton({ icon: Icon, onPress, active, label, tint }: { icon: typeof Cable; onPress: () => void; active?: boolean; label: string; tint?: string }) {
  return (
    <PressableScale
      accessibilityLabel={label}
      onPress={() => {
        haptic.light();
        onPress();
      }}
      scaleTo={0.9}
    >
      <Glass radius={22} dense intensity={50}>
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? alpha(tint ?? colors.accent, 0.18) : 'transparent' }}>
          <Icon size={19} color={active ? tint ?? colors.accent : colors.t1} strokeWidth={2.1} />
        </View>
      </Glass>
    </PressableScale>
  );
}

/** Right-hand quick actions: pipe cam, x-ray, reset framing. */
export function SceneControls() {
  const mode = useView((s) => s.mode);
  const xray = useView((s) => s.xray);
  const setMode = useView((s) => s.setMode);
  const exitPipe = useView((s) => s.exitPipe);
  const toggleXray = useView((s) => s.toggleXray);
  return (
    <View style={{ gap: 10 }}>
      {mode === 'pipe' ? (
        <RoundButton icon={X} label="Exit pipe cam" onPress={exitPipe} tint={colors.inpipe} active />
      ) : (
        <RoundButton icon={Cable} label="Pipe cam" onPress={() => setMode('pipe')} />
      )}
      {mode !== 'pipe' && <RoundButton icon={Layers} label="Toggle x-ray" active={xray} onPress={toggleXray} />}
      {mode !== 'pipe' && <RoundButton icon={LocateFixed} label="Reset view" onPress={() => applyCameraPreset('whole')} />}
    </View>
  );
}

/** "Following C-01 ✕" — makes the camera's state obvious and one tap to release. */
export function FollowBadge() {
  const id = useView((s) => s.followRobotId);
  const robot = useWorld((s) => (id ? s.robots[id] : undefined));
  const follow = useView((s) => s.follow);
  if (!id) return null;
  const tone = robot?.class === 'outrig' ? 'outrig' : 'inpipe';
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)}>
      <PressableScale
        onPress={() => {
          haptic.select();
          follow(null);
        }}
        scaleTo={0.95}
        style={{ alignSelf: 'flex-start' }}
      >
        <Glass radius={999} dense>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 10, height: 34 }}>
            <Radar size={14} color={tone === 'outrig' ? colors.outrig : colors.inpipe} strokeWidth={2.2} />
            <T v="caption" color={colors.t1} style={{ fontFamily: 'Geist_600SemiBold' }}>
              Following {labelOfId(id)}
            </T>
            <X size={14} color={colors.t3} />
          </View>
        </Glass>
      </PressableScale>
    </Animated.View>
  );
}

