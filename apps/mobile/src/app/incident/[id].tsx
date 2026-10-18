import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SearchX } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { colors } from '@/theme';
import { openAgent, showEntityOnMap } from '@/lib/nav';
import { ScreenScroll } from '@/components/ScreenScroll';
import { AgentTrace } from '@/components/incident/AgentTrace';
import { ApprovalBanner } from '@/components/incident/ApprovalBanner';
import { Evidence } from '@/components/incident/Evidence';
import { Hypotheses } from '@/components/incident/Hypotheses';
import { IncidentHeader } from '@/components/incident/IncidentHeader';
import { MissionSteps } from '@/components/incident/MissionSteps';
import { StatusLine } from '@/components/incident/StatusLine';
import { Stepper } from '@/components/incident/Stepper';
import { VerificationBlock } from '@/components/incident/VerificationBlock';
import { Button, Chip, EmptyState, Section, T } from '@/components/ui';

export default function IncidentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const inc = useWorld((s) => (id ? s.incidents[id] : undefined));
  const missions = useWorld((s) => s.missions);
  const robots = useWorld((s) => s.robots);

  if (!inc) {
    return (
      <ScreenScroll title={id ?? 'Incident'} variant="detail" backLabel="Back">
        <EmptyState icon={SearchX} tone={colors.t3} title="Incident not found" body="It may have aged out of the recent window, or the backend restarted. Nothing is shown in its place." />
      </ScreenScroll>
    );
  }
  const mine = inc.mission_ids.map((m) => missions[m]).filter(Boolean);

  return (
    <ScreenScroll title={inc.id} variant="detail" backLabel="Back" contentStyle={{ paddingHorizontal: 16, gap: 24 }}>
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
      <Button label="Show on map" flex onPress={() => showEntityOnMap(inc.anchor.entity_id)} />
      <Hypotheses inc={inc} />
      <Evidence inc={inc} />
      {mine.length > 0 && (
        <Section title={`Missions · ${mine.length}`}>
          <View style={{ gap: 12 }}>
            {mine.map((m) => (
              <View key={m.id} style={{ padding: 14, borderRadius: 16, gap: 10, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Chip sm mono tone={robots[m.robot_id]?.class ?? 'neutral'}>
                    {labelOfId(m.robot_id)}
                  </Chip>
                  <T v="monoSmall" color={colors.t3} style={{ flex: 1 }}>
                    {m.id}
                  </T>
                  <T v="mono" color={colors.t2}>
                    {Math.round(m.progress * 100)}%
                  </T>
                </View>
                <T v="headline" style={{ fontSize: 15 }}>
                  {m.title}
                </T>
                <MissionSteps steps={m.steps} />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button label="Agent" size="sm" flex onPress={() => openAgent(m.robot_id)} />
                  <Button label="On map" size="sm" flex onPress={() => showEntityOnMap(m.robot_id)} />
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
