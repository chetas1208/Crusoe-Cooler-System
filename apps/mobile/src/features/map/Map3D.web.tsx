import { View } from 'react-native';
import { T } from '@/components/ui';

export function Map3D({ height }: { height: number; active: boolean }) {
  return (
    <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
      <T v="caption">The 3D scene is native-only.</T>
    </View>
  );
}
