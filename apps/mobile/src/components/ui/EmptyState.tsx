import { View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors } from '@/theme';
import { T } from './Text';

export function EmptyState({ icon: Icon, title, body, tone = colors.nominal }: { icon: LucideIcon; title: string; body: string; tone?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 56, paddingHorizontal: 36, gap: 10 }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line }}>
        <Icon size={22} color={tone} strokeWidth={2} />
      </View>
      <T v="headline" style={{ marginTop: 4 }}>{title}</T>
      <T v="callout" style={{ textAlign: 'center', lineHeight: 20 }}>{body}</T>
    </View>
  );
}
