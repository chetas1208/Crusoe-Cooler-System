import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { ArrowLeft, Check, Radio } from 'lucide-react-native';
import { useWorld } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { useView, type PipeCam as PipeCamId } from '@loopkeeper/scene';
import { colors } from '@/theme';
import { Button, Chip, Dot, Glass, Section, Segmented, Stat, T } from '@/components/ui';
import { MissionSteps, SegmentStrip } from './Inspector';

/** Everything the inside-pipe view derives from sim state (same math as the web HUD). */
export function usePipeTelemetry() {
  const edgeId = useView((s) => s.pipeEdgeId);
  const probeS = useView((s) => s.pipeProbeS);
  const edge = useWorld((s) => (edgeId ? s.edgesById[edgeId] : undefined));
  const state = useWorld((s) => (edgeId ? s.assets[edgeId] : undefined));
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const incidents = useWorld((s) => s.incidents);
  const crawler = useMemo(() => Object.values(robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === edgeId && r.mode !== 'DOCKED'), [robots, edgeId]);
  return useMemo(() => {
    if (!edge) return null;
    const mission = crawler?.mission_id ? missions[crawler.mission_id] : undefined;
    const s = crawler?.pose.s_m ?? probeS ?? Math.max((state?.fault?.location_s_m ?? edge.length_m / 2) - 1.1, 0.2);
    const occ = state?.fault?.occlusion ?? 0;
    const loc = state?.fault?.location_s_m ?? -99;
    const dep = occ * Math.exp(-(((s + 0.2 - loc) / 0.42) ** 2));
    const bore = edge.diameter_mm * (1 - Math.min(dep, 0.9));
    const obs = Object.values(incidents).flatMap((i) => i.evidence.filter((e) => e.kind === 'observation' && e.asset_id === edge.id));
    return { edge, state, crawler, mission, s, dep, bore, obs, rd: state?.readings ?? {} };
  }, [edge, state, crawler, missions, incidents, probeS]);
}

/** Dark bore: vignette, REC badge, camera switch. The 3D view is a rendered virtual viewpoint lit only by the crawler lamp. */
export function PipeCamOverlay({ topInset }: { topInset: number }) {
  const mode = useView((s) => s.mode);
  const cam = useView((s) => s.pipeCam);
  const setCam = useView((s) => s.setPipeCam);
  const t = usePipeTelemetry();
  if (mode !== 'pipe' || !t) return null;
  return (
    <Animated.View entering={FadeIn.duration(500)} exiting={FadeOut.duration(300)} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Svg width="100%" height="100%">
          <Defs>
            <RadialGradient id="vig" cx="50%" cy="46%" rx="75%" ry="62%">
              <Stop offset="0.45" stopColor="#000" stopOpacity="0" />
              <Stop offset="1" stopColor="#000" stopOpacity="0.82" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#vig)" />
        </Svg>
      </View>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, top: topInset }}>
        <Glass radius={16} dense>
          <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, height: 20, borderRadius: 6, backgroundColor: 'rgba(255,79,79,0.16)' }}>
                <Dot tone="critical" pulse size={6} />
                <T v="micro" color={colors.critical} style={{ fontFamily: 'Geist_700Bold', letterSpacing: 0.8 }}>REC</T>
              </View>
              <View style={{ flex: 1 }}>
                <T v="caption" color={colors.t1} style={{ fontFamily: 'Geist_600SemiBold' }} numberOfLines={1}>
                  {t.crawler ? `${labelOfId(t.crawler.id)} · ${cam === 'front' ? 'Front camera' : 'Section view'}` : 'Service probe · no crawler here'}
                </T>
                <T v="micro" color={colors.t3} numberOfLines={1}>
                  Virtual viewpoint · lit only by the crawler lamp
                </T>
              </View>
            </View>
            <Segmented<PipeCamId> small value={cam} onChange={setCam} items={[{ id: 'front', label: 'Front cam' }, { id: 'section', label: 'Section' }]} />
          </View>
        </Glass>
      </View>
    </Animated.View>
  );
}

/** Peek: compact telemetry strip. Half/full: mission, observations, segment schematic. */
export function PipeSheet() {
  const t = usePipeTelemetry();
  const exit = useView((s) => s.exitPipe);
  if (!t) return null;
  const { edge, state, crawler, mission, s, dep, bore, obs, rd } = t;
  const tiles: [string, string, string, 'warning' | undefined][] = [
    ['Along segment', s.toFixed(1), 'm', undefined],
    ['Bore ahead', bore.toFixed(0), 'mm', dep > 0.15 ? 'warning' : undefined],
    ['ΔP segment', (rd.dp_kpa ?? 0).toFixed(1), 'kPa', undefined],
    ['Pipe Ø', String(edge.diameter_mm), 'mm', undefined],
    ['Flow velocity', (rd.velocity_m_s ?? 0).toFixed(2), 'm/s', undefined],
    ['Crawler speed', (crawler?.pose.speed_m_s ?? 0).toFixed(2), 'm/s', undefined],
  ];
  return (
    <Animated.View entering={FadeIn.duration(250)} style={{ gap: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, gap: 1 }}>
          <T v="eyebrow" color={colors.inpipe}>Inside pipe</T>
          <T v="headline" style={{ fontSize: 19 }}>
            {edge.label} <T v="caption" color={colors.t3}>· {edge.name}</T>
          </T>
        </View>
        <Chip tone="inpipe" sm icon={Radio}>{crawler ? crawler.mode.replace('_', ' ') : 'PROBE'}</Chip>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {tiles.slice(0, 3).map(([l, v, u, tone]) => (
          <Stat key={l} label={l} value={v} unit={u} tone={tone} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {tiles.slice(3).map(([l, v, u, tone]) => (
          <Stat key={l} label={l} value={v} unit={u} tone={tone} />
        ))}
      </View>
      <SegmentStrip edge={edge} state={state} />
      <Section title={mission ? `Mission · ${mission.id}` : 'Mission'}>
        {mission ? (
          <>
            <T v="headline" style={{ fontSize: 15 }}>{mission.title}</T>
            <MissionSteps steps={mission.steps} />
          </>
        ) : (
          <T v="callout" color={colors.t3}>No active mission in this segment. The camera is a stationary service probe parked ahead of the suspected restriction.</T>
        )}
      </Section>
      <Section title="Tagged observations">
        {obs.length === 0 ? (
          <T v="callout" color={colors.t3}>None yet — the crawler tags findings as it inspects.</T>
        ) : (
          obs.slice(-4).map((o) => (
            <View key={o.id} style={{ flexDirection: 'row', gap: 9 }}>
              <Check size={14} color={colors.nominal} strokeWidth={2.6} style={{ marginTop: 3 }} />
              <T v="callout" color={colors.t1} style={{ flex: 1 }}>{o.summary}</T>
            </View>
          ))
        )}
      </Section>
      <Button label="Return to facility" icon={ArrowLeft} onPress={exit} />
    </Animated.View>
  );
}
