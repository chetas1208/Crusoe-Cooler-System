import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { colors, radii } from '@/theme';

interface GlassProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  /** left accent bar colour (incident severity etc.) */
  accent?: string;
  /** a touch more opaque, for content-heavy panels */
  dense?: boolean;
}

/** Frosted panel: blur + dark tint + hairline border, per the web glass language. */
export function Glass({ children, style, radius = radii.lg, intensity = 38, accent, dense }: GlassProps) {
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: dense ? 'rgba(14,17,23,0.86)' : colors.panel }]} />
      {accent ? <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent }} /> : null}
      {children}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2 }]} />
    </View>
  );
}
