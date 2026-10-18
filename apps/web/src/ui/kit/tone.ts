import { Ban, CircleCheck, Eye, Info, OctagonAlert, TriangleAlert, Sparkles, Radio, Activity, type LucideIcon } from 'lucide-react';

/** Semantic tones. Colour is NEVER the only signal: every tone has a default icon and components require text. */
export type Tone = 'neutral' | 'accent' | 'info' | 'nominal' | 'watch' | 'warning' | 'critical' | 'isolated' | 'sentinel' | 'inpipe' | 'outrig' | 'service';

export const TONE_ICON: Record<Tone, LucideIcon | null> = {
  neutral: null,
  accent: Sparkles,
  info: Info,
  nominal: CircleCheck,
  watch: Eye,
  warning: TriangleAlert,
  critical: OctagonAlert,
  isolated: Ban,
  sentinel: Radio,
  service: Radio,
  inpipe: Activity,
  outrig: Activity,
};

export const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ');
