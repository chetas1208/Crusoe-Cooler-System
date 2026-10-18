import { ScrollView, View } from 'react-native';
import { colors } from '@/theme';
import { T } from '@/components/ui';
import { redact } from '@/features/agents/status';

const MAX = 1400;

export function JsonBlock({ label, value }: { label: string; value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(redact(value), null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  const clipped = text.length > MAX;
  return (
    <View style={{ gap: 5 }}>
      <T v="eyebrow" style={{ fontSize: 9.5 }}>
        {label}
      </T>
      <View style={{ borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.38)', borderWidth: 1, borderColor: colors.line, maxHeight: 190, overflow: 'hidden' }}>
        <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 10 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
            <T v="monoSmall" selectable color="#c4ccdb" style={{ fontSize: 10.5, lineHeight: 15 }}>
              {clipped ? `${text.slice(0, MAX)}\n…` : text}
            </T>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}
