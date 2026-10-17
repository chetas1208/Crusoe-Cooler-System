import { View } from 'react-native';
import { toneColor, type Tone } from '@/theme';
import { T } from './Text';

export function Stat({ label, value, unit, tone, flex = true }: { label: string; value: React.ReactNode; unit?: string; tone?: Tone; flex?: boolean }) {
  return (
    <View style={[{ gap: 3 }, flex && { flex: 1 }]}>
      <T v="eyebrow" style={{ fontSize: 9.5 }}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <T v="num" color={tone ? toneColor[tone] : undefined} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ fontSize: 19 }}>{value}</T>
        {unit ? <T v="micro" color="#707889">{unit}</T> : null}
      </View>
    </View>
  );
}

export function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }}>
      <T v="callout" color="#707889" style={{ flexShrink: 1 }}>{k}</T>
      <T v="callout" color="#eef1f6" style={{ textAlign: 'right', flexShrink: 2, fontFamily: 'Geist_500Medium' }}>{v}</T>
    </View>
  );
}
