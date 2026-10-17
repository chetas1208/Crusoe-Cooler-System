import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { alpha, colors, toneColor, type Tone } from '@/theme';
import { haptic } from '@/lib/haptics';
import { PressableScale } from './PressableScale';
import { T } from './Text';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  icon?: LucideIcon;
  variant?: 'default' | 'primary' | 'ghost' | 'tone';
  tone?: Tone;
  size?: 'md' | 'sm';
  disabled?: boolean;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  haptics?: 'light' | 'medium' | 'select' | 'none';
  /** stretch to share a row equally */
  flex?: boolean;
}

export function Button({ label, onPress, icon: Icon, variant = 'default', tone = 'accent', size = 'md', disabled, active, style, haptics = 'light', flex }: ButtonProps) {
  const h = size === 'md' ? 44 : 36;
  const primary = variant === 'primary';
  const toned = variant === 'tone';
  const c = toneColor[tone];
  const bg = primary ? colors.accent : toned ? alpha(c, 0.14) : active ? alpha(colors.accent, 0.16) : variant === 'ghost' ? 'transparent' : colors.panel3;
  const border = primary ? 'rgba(255,255,255,0.0)' : toned ? alpha(c, 0.34) : active ? alpha(colors.accent, 0.4) : variant === 'ghost' ? 'transparent' : colors.line2;
  const fg = primary ? '#06201c' : toned ? c : active ? colors.accent : colors.t1;
  return (
    <PressableScale
      disabled={disabled}
      onPress={() => {
        if (haptics === 'light') haptic.light();
        else if (haptics === 'medium') haptic.medium();
        else if (haptics === 'select') haptic.select();
        onPress?.();
      }}
      style={[{ height: h, borderRadius: size === 'md' ? 13 : 11, paddingHorizontal: size === 'md' ? 16 : 13, backgroundColor: bg, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }, flex && { flex: 1 }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {Icon ? <Icon size={size === 'md' ? 16 : 14} color={fg} strokeWidth={2.2} /> : null}
        <T v="headline" color={fg} style={{ fontSize: size === 'md' ? 14.5 : 13, letterSpacing: -0.15, fontFamily: 'Geist_600SemiBold' }}>
          {label}
        </T>
      </View>
    </PressableScale>
  );
}
