import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { colors, fonts } from '@/theme';

export type TextVariant =
  | 'largeTitle'
  | 'title'
  | 'headline'
  | 'body'
  | 'callout'
  | 'caption'
  | 'micro'
  | 'eyebrow'
  | 'mono'
  | 'monoSmall'
  | 'num'
  | 'numLarge';

const tabular: TextStyle['fontVariant'] = ['tabular-nums'];

export const textStyles: Record<TextVariant, TextStyle> = {
  largeTitle: { fontFamily: fonts.bold, fontSize: 32, lineHeight: 38, letterSpacing: -0.9 },
  title: { fontFamily: fonts.semibold, fontSize: 22, lineHeight: 28, letterSpacing: -0.45 },
  headline: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 21, letterSpacing: -0.2 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, letterSpacing: -0.1 },
  callout: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19.5, letterSpacing: -0.05 },
  caption: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16 },
  micro: { fontFamily: fonts.medium, fontSize: 10.5, lineHeight: 14, letterSpacing: 0.1 },
  eyebrow: { fontFamily: fonts.semibold, fontSize: 10.5, lineHeight: 14, letterSpacing: 0.95, textTransform: 'uppercase' },
  mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 16, fontVariant: tabular },
  monoSmall: { fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 14, fontVariant: tabular },
  num: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2, fontVariant: tabular },
  numLarge: { fontFamily: fonts.bold, fontSize: 26, lineHeight: 30, letterSpacing: -0.7, fontVariant: tabular },
};

export interface TProps extends TextProps {
  v?: TextVariant;
  color?: string;
}

/** The one text primitive: Geist, tabular numerals for readings, iOS-ish tracking. */
export function T({ v = 'body', color, style, ...rest }: TProps) {
  const defaultColor = v === 'eyebrow' ? colors.t3 : v === 'callout' || v === 'caption' ? colors.t2 : colors.t1;
  return <RNText allowFontScaling={false} {...rest} style={[textStyles[v], { color: color ?? defaultColor }, style]} />;
}
