/** Design tokens — mirrors apps/web/src/styles/tokens.css so both clients read as one product. */
export const colors = {
  bg: '#090b0f',
  bgTop: '#151a22',
  panel: 'rgba(16,19,26,0.74)',
  panelSolid: '#11141a',
  panelRaised: '#171b23',
  panel2: 'rgba(255,255,255,0.04)',
  panel3: 'rgba(255,255,255,0.07)',
  line: 'rgba(255,255,255,0.075)',
  line2: 'rgba(255,255,255,0.14)',

  t1: '#eef1f6',
  t2: '#a9b1c0',
  t3: '#707889',
  t4: '#4b5263',

  accent: '#5be3d0',
  accentSoft: 'rgba(91,227,208,0.14)',
  sentinel: '#a78bfa',
  inpipe: '#2fd3e8',
  outrig: '#ff9a3c',

  nominal: '#41d6a3',
  watch: '#e7cb4b',
  warning: '#ff9a3c',
  critical: '#ff4f4f',
  isolated: '#8b93a7',
  service: '#a78bfa',
} as const;

export const radii = { xl: 20, lg: 16, md: 12, sm: 8, pill: 999 } as const;
export const gutter = 16;

export type Tone =
  | 'neutral'
  | 'nominal'
  | 'watch'
  | 'warning'
  | 'critical'
  | 'isolated'
  | 'service'
  | 'sentinel'
  | 'inpipe'
  | 'outrig'
  | 'accent';

export const toneColor: Record<Tone, string> = {
  neutral: colors.t2,
  nominal: colors.nominal,
  watch: colors.watch,
  warning: colors.warning,
  critical: colors.critical,
  isolated: colors.isolated,
  service: colors.sentinel,
  sentinel: colors.sentinel,
  inpipe: colors.inpipe,
  outrig: colors.outrig,
  accent: colors.accent,
};

export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Tinted surface + border for a tone (chips, banners). */
export function toneSurface(tone: Tone, strength = 1) {
  if (tone === 'neutral') return { bg: colors.panel2, border: colors.line, fg: colors.t2 };
  const c = toneColor[tone];
  return { bg: alpha(c, 0.1 * strength), border: alpha(c, 0.26 * strength), fg: c };
}

export const agentTone = (role: 'sentinel' | 'inpipe' | 'outrig'): Tone => role;
