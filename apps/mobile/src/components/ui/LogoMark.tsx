import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Defs>
        <LinearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7af0de" />
          <Stop offset="1" stopColor="#2fb7cf" />
        </LinearGradient>
      </Defs>
      <Circle cx={16} cy={16} r={11} fill="none" stroke="url(#lg)" strokeWidth={3.2} strokeLinecap="round" strokeDasharray="55 14" transform="rotate(-62 16 16)" />
      <Circle cx={26.4} cy={11.4} r={3} fill="#ff9a3c" />
    </Svg>
  );
}
