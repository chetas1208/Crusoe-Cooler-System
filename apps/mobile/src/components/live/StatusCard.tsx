import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { FlaskConical, WifiOff } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { formatSimClock } from '@loopkeeper/core';
import { alpha, colors, toneColor } from '@/theme';
import { useLinkStatus } from '@/hooks/useConnection';
import { haptic } from '@/lib/haptics';
import { Chip, Dot, Glass, T } from '@/components/ui';

function Vital({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: 'nominal' | 'warning' | 'critical' | 'watch' }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="eyebrow" style={{ fontSize: 9 }}>
        {label}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
        <T v="num" color={tone ? toneColor[tone] : colors.t1} style={{ fontSize: 18, lineHeight: 22 }}>
          {value}
        </T>
        {unit ? (
          <T v="micro" color={colors.t3}>
            {unit}
          </T>
        ) : null}
      </View>
    </View>
  );
}

/** Floating top status: facility · link state · sim clock · MOCK, with the three numbers an operator checks first. */
export function StatusCard({ compact }: { compact?: boolean }) {
  const facility = useWorld((s) => s.topology?.facility);
  const simTime = useWorld((s) => s.simTimeS);
  const speed = useWorld((s) => s.simSpeed);
  const health = useWorld((s) => s.health);
  const kpis = useWorld((s) => s.kpis);
  const limits = useWorld((s) => s.topology?.limits);
  const link = useLinkStatus();

  const margin = kpis?.min_margin_k;
  const mTone = margin === undefined || !limits ? undefined : margin < limits.margin_crit_k ? 'critical' : margin < limits.margin_warn_k ? 'warning' : 'nominal';
  const open = kpis?.open_incidents ?? 0;
  const mock = health?.backend === 'mock';

  // a link that is no longer trustworthy deserves a physical cue
  useEffect(() => {
    if (link.degraded) haptic.warning();
  }, [link.degraded]);

  return (
    <View style={{ gap: 8 }}>
      <Glass radius={20} dense>
        <View style={{ paddingHorizontal: 14, paddingTop: 11, paddingBottom: 12, gap: 11 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Dot tone={link.tone} pulse={link.level === 'live'} />
            <T v="headline" style={{ fontSize: 15, flexShrink: 1 }} numberOfLines={1}>
              {facility?.name ?? 'Connecting…'}
            </T>
            <Chip tone={link.tone} sm>
              {link.label}
            </Chip>
            {mock ? (
              <Chip tone="watch" sm icon={FlaskConical}>
                MOCK
              </Chip>
            ) : null}
          </View>
          <T v="monoSmall" color={colors.t3} style={{ marginTop: -6, letterSpacing: 0.3 }}>
            SIMULATED FACILITY · T+{formatSimClock(simTime)} · ×{speed % 1 ? speed.toFixed(1) : speed}
          </T>
          {!compact && (
            <>
              <View style={{ height: 1, backgroundColor: colors.line }} />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Vital label="Min margin" value={margin === undefined ? '—' : margin.toFixed(1)} unit="K" tone={mTone} />
                <Vital label="TCS flow" value={kpis ? kpis.tcs_flow_kg_s.toFixed(1) : '—'} unit="kg/s" />
                <Vital label="Incidents" value={String(open)} tone={open ? 'warning' : 'nominal'} />
              </View>
            </>
          )}
        </View>
      </Glass>
      {link.degraded && (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(160)} layout={LinearTransition}>
          <Glass radius={14} dense>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingVertical: 11, backgroundColor: alpha(colors.warning, 0.1) }}>
              <WifiOff size={16} color={colors.warning} strokeWidth={2.3} />
              <View style={{ flex: 1 }}>
                <T v="caption" color={colors.warning} style={{ fontFamily: 'Geist_600SemiBold' }}>
                  {link.level === 'stale' ? 'STALE — the stream has gone quiet' : link.level === 'offline' ? 'OFFLINE — backend unreachable' : 'RECONNECTING to the backend'}
                </T>
                <T v="micro" color={colors.t2}>
                  Showing the last known facility state, not live data. Commands are unavailable until the link recovers.
                </T>
              </View>
            </View>
          </Glass>
        </Animated.View>
      )}
    </View>
  );
}
