import { useMemo } from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { T } from './Text';

export function Sparkline({ data, w = 300, h = 44, color = '#5be3d0' }: { data: [number, number][]; w?: number; h?: number; color?: string }) {
  const g = useMemo(() => {
    if (data.length < 2) return null;
    const ys = data.map((d) => d[1]);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const span = Math.max(hi - lo, 1e-6);
    const x0 = data[0][0];
    const xs = Math.max(data[data.length - 1][0] - x0, 1e-6);
    const pad = 3;
    const pts = data.map((d) => [((d[0] - x0) / xs) * (w - pad * 2) + pad, h - pad - ((d[1] - lo) / span) * (h - pad * 2)] as const);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    return { line, area: `${line}L${last[0].toFixed(1)},${h}L${pts[0][0].toFixed(1)},${h}Z`, last };
  }, [data, w, h]);
  if (!g) return <T v="micro" color="#4b5263" style={{ height: h, textAlignVertical: 'center' }}>collecting…</T>;
  return (
    <Svg width={w} height={h}>
      <Defs>
        <LinearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.28" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Path d={g.area} fill="url(#spark)" />
      <Path d={g.line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={g.last[0]} cy={g.last[1]} r={2.6} fill={color} />
    </Svg>
  );
}
