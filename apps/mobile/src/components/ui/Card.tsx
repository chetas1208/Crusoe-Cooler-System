import { View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '@/theme';
import { T } from './Text';

/** Grouped surface for settings-style rows (iOS inset-grouped feel, dark). */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }, style]}>
      {children}
    </View>
  );
}

export function Row({ label, value, mono, last, right, tone }: { label: string; value?: React.ReactNode; mono?: boolean; last?: boolean; right?: React.ReactNode; tone?: string }) {
  return (
    <View style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingHorizontal: 15, paddingVertical: 10, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.line }}>
      <T v="callout" color={colors.t2} style={{ fontSize: 14 }}>
        {label}
      </T>
      {right ?? (
        <T v={mono ? 'mono' : 'callout'} color={tone ?? colors.t1} numberOfLines={1} style={{ flexShrink: 1, textAlign: 'right', fontSize: mono ? 12.5 : 14, fontFamily: mono ? 'GeistMono_500Medium' : 'Geist_500Medium' }}>
          {value}
        </T>
      )}
    </View>
  );
}

export function GroupTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <View style={{ gap: 4, paddingHorizontal: 4 }}>
      <T v="eyebrow">{children}</T>
      {hint ? (
        <T v="micro" color={colors.t4} style={{ lineHeight: 15 }}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}
