import { useWorld } from '@loopkeeper/core/store';
import type { Tone } from '@/theme';

export type LinkLevel = 'live' | 'paused' | 'stale' | 'reconnecting' | 'offline' | 'connecting';

export interface LinkStatus {
  level: LinkLevel;
  label: string;
  tone: Tone;
  /** data on screen is the last known snapshot, not current */
  degraded: boolean;
}

/** One honest answer to "can I trust what I am looking at?" (frontend-ui.md §8: STALE, never a fake green heartbeat). */
export function useLinkStatus(): LinkStatus {
  const connection = useWorld((s) => s.connection);
  const stale = useWorld((s) => s.stale);
  const phase = useWorld((s) => s.phase);
  const status = useWorld((s) => s.simStatus);
  if (phase === 'error' || connection === 'offline') return { level: 'offline', label: 'OFFLINE', tone: 'critical', degraded: true };
  if (connection === 'reconnecting') return { level: 'reconnecting', label: 'RECONNECTING', tone: 'warning', degraded: true };
  if (connection === 'connecting') return { level: 'connecting', label: 'CONNECTING', tone: 'warning', degraded: true };
  if (stale) return { level: 'stale', label: 'STALE', tone: 'warning', degraded: true };
  if (status === 'paused') return { level: 'paused', label: 'PAUSED', tone: 'watch', degraded: false };
  return { level: 'live', label: 'LIVE', tone: 'nominal', degraded: false };
}
