import { View, type StyleProp, type ViewStyle } from 'react-native';
import { T } from './Text';

export function Section({ title, right, children, style }: { title: string; right?: React.ReactNode; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 10 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T v="eyebrow">{title}</T>
        {right}
      </View>
      {children}
    </View>
  );
}
