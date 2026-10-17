import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Info, TriangleAlert } from 'lucide-react-native';
import { useView } from '@loopkeeper/scene';
import { colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { Glass, T } from '@/components/ui';

/** Scene notices ("that segment cannot be entered: …") surfaced as a transient toast — explained, never silent. */
export function Toast() {
  const notice = useView((s) => s.notice);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    if (!notice) return;
    if (notice.tone === 'warn') haptic.warning();
    const t = setTimeout(() => setDismissed(notice.id), 3800);
    return () => clearTimeout(t);
  }, [notice]);
  const shown = notice && dismissed !== notice.id ? notice : null;
  if (!shown) return null;
  const warn = shown.tone === 'warn';
  const Icon = warn ? TriangleAlert : Info;
  return (
    <Animated.View key={shown.id} entering={FadeInDown.springify().damping(22)} exiting={FadeOutDown.duration(180)} pointerEvents="none">
      <Glass radius={16} dense>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 }}>
          <Icon size={16} color={warn ? colors.warning : colors.accent} strokeWidth={2.3} />
          <T v="callout" color={colors.t1} style={{ flex: 1 }}>
            {shown.text}
          </T>
        </View>
      </Glass>
    </Animated.View>
  );
}
