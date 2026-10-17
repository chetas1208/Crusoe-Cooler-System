import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Cable, Crosshair, SearchX } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { colors } from '@/theme';
import { followRobot, incidentPipeEdge, openPipeCam, showEntityOnMap, showIncidentOnMap } from '@/lib/nav';
import { ScreenScroll } from '@/components/ScreenScroll';
import { AgentTrace } from '@/components/incident/AgentTrace';
import { ApprovalBanner } from '@/components/incident/ApprovalBanner';
import { Evidence } from '@/components/incident/Evidence';
import { Hypotheses } from '@/components/incident/Hypotheses';
import { IncidentHeader } from '@/components/incident/IncidentHeader';
import { StatusLine } from '@/components/incident/StatusLine';
import { Stepper } from '@/components/incident/Stepper';
import { VerificationBlock } from '@/components/incident/VerificationBlock';
import { MissionSteps } from '@/components/live/Inspector';
import { Button, Chip, EmptyState, Section, T } from '@/components/ui';

export default function IncidentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const inc = useWorld((s) => (id ? s.incidents[id] : undefined));
  const missions = useWorld((s) => s.missions);
  const robots = useWorld((s) => s.robots);
  const select = useView((s) => s.select);
  void select;

  if (!inc) {
    return (
      <ScreenScroll title={id ?? 'Incident'} variant="detail" backLabel="Incidents">
        <EmptyState icon={SearchX} tone={colors.t3} title="Incident not found" body="It may have aged out of the recent window, or the backend restarted. Nothing is shown in its place." />
      </ScreenScroll>
    );
  }
  const pipeEdge = incidentPipeEdge(inc.id);
  const crawler = Object.values(robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === pipeEdge && r.mode !== 'DOCKED');
  const mine = inc.mission_ids.map((m) => missions[m]).filter(Boolean);

  return (
    <ScreenScroll title={inc.id} variant="detail" backLabel="Incidents" contentStyle={{ paddingHorizontal: 16, gap: 24 }}>
      <View style={{ gap: 18 }}>
        <IncidentHeader inc={inc} large />
        <Stepper inc={inc} showRetry />
        <StatusLine inc={inc} />
      </View>
      <ApprovalBanner inc={inc} />
      <VerificationBlock inc={inc} />
      <T v="body" color={colors.t2} style={{ lineHeight: 22 }}>
        {inc.summary}
      </T>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Show on map" icon={Crosshair} flex onPress={() => showIncidentOnMap(inc.id)} />
        {pipeEdge ? <Button label="Pipe cam" icon={Cable} variant="tone" tone="inpipe" flex onPress={() => openPipeCam(pipeEdge, crawler?.id)} /> : null}
      </View>
      <Hypotheses inc={inc} />
      <Evidence inc={inc} />
      {mine.length > 0 && (
        <Section title={`Missions · ${mine.length}`}>
          <View style={{ gap: 12 }}>
            {mine.map((m) => (
              <View key={m.id} style={{ padding: 14, borderRadius: 16, gap: 10, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Chip sm mono tone={m.robot_id.startsWith('c_') ? 'inpipe' : 'outrig'}>{labelOfId(m.robot_id)}</Chip>
                  <T v="monoSmall" color={colors.t3} style={{ flex: 1 }}>{m.id}</T>
                  <T v="mono" color={colors.t2}>{Math.round(m.progress * 100)}%</T>
                </View>
                <T v="headline" style={{ fontSize: 15 }}>{m.title}</T>
                <MissionSteps steps={m.steps} />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button label="Follow" size="sm" flex onPress={() => followRobot(m.robot_id)} />
                  <Button label="Target" size="sm" flex onPress={() => showEntityOnMap(m.target_id)} />
                </View>
              </View>
            ))}
          </View>
        </Section>
      )}
      <AgentTrace incidentId={inc.id} onFocusEntity={showEntityOnMap} />
    </ScreenScroll>
  );
}
