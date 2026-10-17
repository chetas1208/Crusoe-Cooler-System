import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { toneSurface, type Tone } from '@/theme';
import { T } from './Text';

interface ChipProps {
  tone?: Tone;
  children: React.ReactNode;
  sm?: boolean;
  icon?: LucideIcon;
  leading?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  mono?: boolean;
}

export function Chip({ tone = 'neutral', children, sm, icon: Icon, leading, style, mono }: ChipProps) {
  const s = toneSurface(tone);
  const h = sm ? 20 : 24;
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 5, height: h, paddingHorizontal: sm ? 7 : 9, borderRadius: 999, backgroundColor: s.bg, borderWidth: 1, borderColor: s.border, alignSelf: 'flex-start' }, style]}>
      {leading}
      {Icon ? <Icon size={sm ? 10 : 12} color={s.fg} strokeWidth={2.4} /> : null}
      <T v={mono ? 'monoSmall' : 'micro'} color={s.fg} style={{ fontSize: sm ? 10.5 : 11.5, letterSpacing: 0.15 }}>
        {children}
      </T>
    </View>
  );
}
