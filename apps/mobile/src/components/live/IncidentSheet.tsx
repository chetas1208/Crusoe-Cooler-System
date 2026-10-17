import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Cable, ChevronRight, Crosshair, ShieldCheck } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from '@loopkeeper/scene';
import { colors, toneColor } from '@/theme';
import { haptic } from '@/lib/haptics';
import { incidentPipeEdge, openIncident, openPipeCam } from '@/lib/nav';
import { incidentTone, useOpenIncidents, usePinnedIncident } from '@/hooks/useIncidents';
import { ApprovalBanner } from '@/components/incident/ApprovalBanner';
import { Hypotheses } from '@/components/incident/Hypotheses';
import { IncidentHeader } from '@/components/incident/IncidentHeader';
import { StatusLine } from '@/components/incident/StatusLine';
import { Stepper } from '@/components/incident/Stepper';
import { VerificationBlock } from '@/components/incident/VerificationBlock';
import { Button, Dot, PressableScale, T } from '@/components/ui';
import { useLiveUi } from './liveUi';

function NominalOverview() {
  const kpis = useWorld((s) => s.kpis);
  const resolved = kpis?.resolved_incidents ?? 0;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(65,214,163,0.12)', borderWidth: 1, borderColor: 'rgba(65,214,163,0.28)' }}>
          <ShieldCheck size={19} color={colors.nominal} strokeWidth={2.3} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="headline">No incidents</T>
          <T v="callout" color={colors.t2}>
            The plant is nominal. SENTINEL is watching; faults arrive from seeded wear in the simulated facility.
          </T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, gap: 3 }}>
          <T v="eyebrow" style={{ fontSize: 9.5 }}>Resolved this session</T>
          <T v="numLarge">{resolved}</T>
        </View>
        <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, gap: 3 }}>
          <T v="eyebrow" style={{ fontSize: 9.5 }}>Tip</T>
          <T v="callout" color={colors.t2} style={{ fontSize: 12.5, lineHeight: 17 }}>Tap any rack, pipe, pump or robot to inspect it.</T>
        </View>
      </View>
    </View>
  );
}

/** The pinned incident card: severity, stepper, live status, approval banner, verification, hypotheses. */
export function IncidentSheet() {
  const pinned = useLiveUi((s) => s.pinned);
  const pin = useLiveUi((s) => s.pin);
  const open = useOpenIncidents();
  const inc = usePinnedIncident(pinned);
  const focusIncident = useView((s) => s.focusIncident);
  const pipeEdge = inc ? incidentPipeEdge(inc.id) : null;
  const crawlerId = useWorld((s) => (pipeEdge ? Object.values(s.robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === pipeEdge && r.mode !== 'DOCKED')?.id : undefined));
  if (!inc) return <NominalOverview />;
  return (
    <Animated.View key={inc.id} entering={FadeIn.duration(220)} exiting={FadeOut.duration(120)} layout={LinearTransition} style={{ gap: 16 }}>
      {open.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ marginHorizontal: -16 }}>
          {open.map((i) => {
            const on = i.id === inc.id;
            return (
              <PressableScale key={i.id} scaleTo={0.94} onPress={() => (haptic.select(), pin(i.id))}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 30, paddingHorizontal: 11, borderRadius: 999, backgroundColor: on ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: on ? colors.line2 : colors.line }}>
                  <Dot tone={incidentTone(i)} size={6} pulse={on} />
                  <T v="monoSmall" color={on ? colors.t1 : colors.t2}>{i.id}</T>
                </View>
              </PressableScale>
            );
          })}
        </ScrollView>
      )}
      <IncidentHeader inc={inc} />
      <ApprovalBanner inc={inc} />
      <Stepper inc={inc} />
      <StatusLine inc={inc} />
      <VerificationBlock inc={inc} />
      <T v="callout" color={colors.t2} style={{ lineHeight: 20 }}>
        {inc.summary}
      </T>
      <Hypotheses inc={inc} />
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Button label="Show on map" icon={Crosshair} size="sm" onPress={() => focusIncident(inc.id)} flex />
        {pipeEdge ? <Button label="Pipe cam" icon={Cable} size="sm" tone="inpipe" variant="tone" onPress={() => openPipeCam(pipeEdge, crawlerId)} flex /> : null}
      </View>
      <PressableScale onPress={() => (haptic.light(), openIncident(inc.id))} scaleTo={0.985}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 14, backgroundColor: 'rgba(167,139,250,0.08)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.24)' }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: toneColor.sentinel }} />
          <T v="callout" color={colors.t1} style={{ flex: 1, fontFamily: 'Geist_500Medium' }}>
            Evidence &amp; agent trace
          </T>
          <ChevronRight size={16} color={colors.t3} />
        </View>
      </PressableScale>
    </Animated.View>
  );
}
