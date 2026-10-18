import { View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import { CircleCheck } from 'lucide-react-native';
import { formatSimClock } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { openIncident } from '@/lib/nav';
import { useLinkStatus } from '@/hooks/useConnection';
import { useIncidents, useOpenIncidents, usePinnedIncident } from '@/hooks/useIncidents';
import { ScreenScroll } from '@/components/ScreenScroll';
import { AuthGate } from '@/components/AuthGate';
import { ApprovalBanner } from '@/components/incident/ApprovalBanner';
import { IncidentHeader } from '@/components/incident/IncidentHeader';
import { IncidentRow } from '@/components/incident/IncidentRow';
import { StatusLine } from '@/components/incident/StatusLine';
import { Stepper } from '@/components/incident/Stepper';
import { VerificationBlock } from '@/components/incident/VerificationBlock';
import { Button, Chip, PressableScale, Section, Stat, T } from '@/components/ui';
import { HealthStrip } from '@/features/dashboard/HealthStrip';
import { FleetCounts } from '@/features/dashboard/FleetCounts';

const CONSEQ = new Set(['incident', 'verify', 'approval']);

export default function Dashboard() {
  const link = useLinkStatus();
  const kpis = useWorld((s) => s.kpis);
  const simTime = useWorld((s) => s.simTimeS);
  const backend = useWorld((s) => s.health?.backend);
  const facility = useWorld((s) => s.topology?.facility.name);
  const open = useOpenIncidents();
  const all = useIncidents();
  const pinned = usePinnedIncident();
  const feed = useWorld(useShallow((s) => s.feed.filter((f) => CONSEQ.has(f.kind) || f.severity === 'warning' || f.severity === 'critical').slice(0, 5)));
  const others = open.filter((i) => i.id !== pinned?.id).slice(0, 3);
  const recentClosed = all.filter((i) => i.closed_tick !== undefined && i.id !== pinned?.id).slice(0, 2);

  return (
    <ScreenScroll title="Dashboard" contentStyle={{ paddingHorizontal: 16, gap: 22 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: -4 }}>
        <Chip tone={link.tone}>{link.label}</Chip>
        <Chip tone="neutral">SIMULATED FACILITY</Chip>
        {backend === 'mock' ? <Chip tone="watch">MOCK BACKEND</Chip> : backend ? <Chip tone="nominal">LIVE BACKEND</Chip> : null}
        <Chip tone="neutral" mono>
          T+{formatSimClock(simTime)}
        </Chip>
      </View>
      <AuthGate />

      <Section title={`Cooling health${facility ? ` · ${facility}` : ''}`}>
        <HealthStrip />
        <View style={{ flexDirection: 'row', gap: 14, paddingHorizontal: 2 }}>
          <Stat label="Min margin" value={kpis ? kpis.min_margin_k.toFixed(1) : '—'} unit="K" tone={kpis && kpis.min_margin_k < 3 ? 'critical' : kpis && kpis.min_margin_k < 6 ? 'watch' : undefined} />
          <Stat label="Heat load" value={kpis ? kpis.total_heat_kw.toFixed(0) : '—'} unit="kW" />
          <Stat label="Open" value={kpis ? String(kpis.open_incidents) : String(open.length)} unit="incidents" tone={open.length ? 'warning' : 'nominal'} />
        </View>
      </Section>

      <Section title="Incident">
        {pinned ? (
          <View style={{ gap: 16, padding: 16, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: colors.line2 }}>
            <IncidentHeader inc={pinned} />
            <Stepper inc={pinned} compact />
            <StatusLine inc={pinned} />
            <ApprovalBanner inc={pinned} />
            <VerificationBlock inc={pinned} />
            <Button label="Open incident" variant="tone" tone="accent" onPress={() => openIncident(pinned.id)} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
            <CircleCheck size={22} color={colors.nominal} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="headline" style={{ fontSize: 15 }}>
                No open incident
              </T>
              <T v="caption" color={colors.t2}>
                SENTINEL has nothing to act on. Launch one from the Execution tab.
              </T>
            </View>
          </View>
        )}
        {[...others, ...recentClosed].map((i) => (
          <IncidentRow key={i.id} inc={i} onPress={() => openIncident(i.id)} />
        ))}
      </Section>

      <Section title="Fleet">
        <FleetCounts />
      </Section>

      <Section title="Recent events">
        {feed.length === 0 ? (
          <T v="callout" color={colors.t3}>
            No incident, approval or verification events yet.
          </T>
        ) : (
          <View style={{ gap: 0, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
            {feed.map((f, i) => (
              <PressableScale key={f.id} scaleTo={0.995} disabled={!f.incidentId} onPress={() => f.incidentId && openIncident(f.incidentId)} style={{ padding: 12, gap: 2, borderBottomWidth: i === feed.length - 1 ? 0 : 1, borderBottomColor: colors.line }}>
                <T v="callout" color={f.severity === 'critical' ? colors.critical : f.severity === 'warning' ? colors.warning : f.severity === 'ok' ? colors.nominal : colors.t1} numberOfLines={2}>
                  {f.text}
                </T>
                <T v="monoSmall" color={colors.t4}>
                  T+{formatSimClock(f.simTimeS)}
                </T>
              </PressableScale>
            ))}
          </View>
        )}
      </Section>
    </ScreenScroll>
  );
}
