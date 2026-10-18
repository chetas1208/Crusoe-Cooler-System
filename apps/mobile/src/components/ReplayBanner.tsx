import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayer } from '@loopkeeper/core/runs';
import { alpha, colors } from '@/theme';
import { T } from '@/components/ui';

/** Always visible while any tab shows a replayed world: nothing on screen is live, and commands are refused. */
export function ReplayBanner() {
  const active = usePlayer((s) => s.phase === 'ready' && !s.monitor);
  const runId = usePlayer((s) => s.runId);
  const insets = useSafeAreaInsets();
  if (!active) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, paddingTop: insets.top + 2, paddingBottom: 4, backgroundColor: alpha(colors.watch, 0.92), alignItems: 'center', zIndex: 40 }}>
      <T v="micro" color="#1a1500" style={{ fontFamily: 'Geist_700Bold', letterSpacing: 0.8 }}>
        REPLAY · {runId} · READ-ONLY · not live
      </T>
    </View>
  );
}
