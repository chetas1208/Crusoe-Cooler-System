import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Svg, { Circle, Ellipse, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { ArrowRight, Bot, Cable, ChevronRight, Cpu, Crosshair, Gauge, Network, Radar, ShieldAlert, X } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { fetchSeriesBackfill, useWorld } from '@loopkeeper/core/store';
import { READING_META, type Asset, type AssetState, type PipeEdge, type Robot } from '@loopkeeper/core/contracts';
import { INCIDENT_STATUS_LABEL, ROBOT_MODE_LABEL, STATUS_LABEL, formatDuration, labelOfId } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { alpha, colors, toneColor, type Tone } from '@/theme';
import { haptic } from '@/lib/haptics';
import { openIncident, openPipeCam } from '@/lib/nav';
import { useSeries } from '@/hooks/useSeries';
import { Button, Chip, Dot, KV, Meter, PressableScale, Section, Sparkline, Stat, T } from '@/components/ui';

const KEY_METRICS: Record<string, string[]> = {
  rack: ['margin_k', 't_chip_c', 'power_kw', 'flow_kg_s', 't_out_c'],
  cdu: ['heat_duty_kw', 'approach_k', 'tcs_supply_c', 'tcs_return_c', 'tcs_flow_kg_s', 'fws_flow_kg_s'],
  pump: ['head_kpa', 'vibration_mm_s', 'speed_pct', 'flow_kg_s'],
  valve: ['opening_pct', 'flow_kg_s'],
  strainer: ['strainer_dp_kpa', 'flow_kg_s'],
  sensor: ['flow_kg_s'],
  pipe: ['flow_kg_s', 'dp_kpa', 'velocity_m_s'],
  chiller: ['fws_in_c', 'fws_out_c'],
};

const TYPE_LABEL: Record<string, string> = { rack: 'Rack', cdu: 'Coolant distribution unit', pump: 'Pump', valve: 'Valve', strainer: 'Strainer', sensor: 'Flow meter', pipe: 'Pipe segment', port: 'Access port', chiller: 'Chiller', dock: 'Dock' };
const toneOf = (s?: string): Tone => (s === 'isolated' || s === 'offline' ? 'isolated' : s === 'service' ? 'service' : ((s ?? 'nominal') as Tone));
const fmt = (metric: string, v: number | undefined) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(READING_META[metric]?.decimals ?? 1));

/* ───────────────────────── shared pieces ───────────────────────── */

function Header({ icon, iconTone, title, name, status, onClose }: { icon: React.ReactNode; iconTone?: Tone; title: string; name: string; status?: string; onClose: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(iconTone ? toneColor[iconTone] : colors.accent, 0.12), borderWidth: 1, borderColor: alpha(iconTone ? toneColor[iconTone] : colors.accent, 0.26) }}>{icon}</View>
      <View style={{ flex: 1, gap: 1 }}>
        <T v="headline" style={{ fontSize: 17 }} numberOfLines={1}>{title}</T>
        <T v="caption" color={colors.t3} numberOfLines={1}>{name}</T>
      </View>
      {status ? (
        <Chip tone={toneOf(status)} sm leading={<Dot tone={toneOf(status)} size={6} />}>
          {STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
        </Chip>
      ) : null}
      <PressableScale
        accessibilityLabel="Close inspector"
        onPress={() => {
          haptic.light();
          onClose();
        }}
        scaleTo={0.88}
        style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' }}
      >
        <X size={16} color={colors.t2} strokeWidth={2.4} />
      </PressableScale>
    </View>
  );
}

function Readings({ assetId, type, state }: { assetId: string; type: string; state?: AssetState }) {
  const metrics = (KEY_METRICS[type] ?? []).filter((m) => state?.readings[m] !== undefined);
  const spark = metrics[0];
  const series = useSeries(assetId, spark ?? '', 80);
  useEffect(() => {
    if (metrics.length) void fetchSeriesBackfill(assetId, metrics.slice(0, 3));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);
  if (!metrics.length) return null;
  const suspect = state?.suspect ?? [];
  return (
    <Section title="Live readings" right={suspect.length ? <Chip tone="warning" sm>suspect</Chip> : undefined}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, columnGap: 12 }}>
        {metrics.slice(0, 4).map((m) => (
          <View key={m} style={{ width: '47%' }}>
            <Stat label={READING_META[m]?.label ?? m} value={fmt(m, state?.readings[m])} unit={READING_META[m]?.unit} tone={suspect.includes(m) ? 'warning' : undefined} flex={false} />
          </View>
        ))}
      </View>
      {metrics.length > 4 && (
        <View style={{ gap: 0 }}>
          {metrics.slice(4).map((m) => (
            <KV key={m} k={READING_META[m]?.label ?? m} v={`${fmt(m, state?.readings[m])} ${READING_META[m]?.unit ?? ''}`} />
          ))}
        </View>
      )}
      {spark ? (
        <View style={{ gap: 5, marginTop: 2 }}>
          <Sparkline data={series} w={326} h={44} color={toneOf(state?.status) === 'nominal' ? colors.accent : toneColor[toneOf(state?.status)]} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T v="micro" color={colors.t3}>{READING_META[spark]?.label}</T>
            <T v="micro" color={colors.t4}>last {Math.round(series.length ? series[series.length - 1][0] - series[0][0] : 0)} s sim</T>
          </View>
        </View>
      ) : null}
    </Section>
  );
}

function TwinTruth({ state, edge }: { state?: AssetState; edge?: PipeEdge }) {
  const f = state?.fault;
  if (!f) return null;
  const rows: [string, string][] = [];
  if (f.occlusion !== undefined) rows.push(['Bore blocked', `${Math.round(f.occlusion * 100)}%`]);
  if (f.location_s_m !== undefined && edge) rows.push(['Deposit location', `s = ${f.location_s_m.toFixed(1)} m of ${edge.length_m.toFixed(1)} m`]);
  if (f.opening !== undefined) rows.push(['Effective opening', `${Math.round(f.opening * 100)}% (commanded ${Math.round((f.commanded_opening ?? 0.85) * 100)}%)`]);
  if (f.health !== undefined) rows.push(['Pump health', `${Math.round(f.health * 100)}%`]);
  if (!rows.length) return null;
  return (
    <Section title="Simulator truth" right={<Chip sm tone="sentinel" icon={ShieldAlert}>twin only</Chip>}>
      <T v="micro" color={colors.t3} style={{ marginTop: -4 }}>Hidden from the agents — they must discover it by inspection.</T>
      <View>{rows.map(([k, v]) => <KV key={k} k={k} v={v} />)}</View>
    </Section>
  );
}

function Linked({ id }: { id: string }) {
  const incidents = useWorld(useShallow((s) => Object.values(s.incidents).filter((i) => i.anchor.entity_id === id || i.affected_asset_ids.includes(id)).sort((a, b) => b.opened_tick - a.opened_tick).slice(0, 3)));
  const simTime = useWorld((s) => s.simTimeS);
  if (!incidents.length) return null;
  return (
    <Section title="Linked incidents">
      <View style={{ gap: 8 }}>
        {incidents.map((i) => (
          <PressableScale key={i.id} scaleTo={0.985} onPress={() => (haptic.light(), openIncident(i.id))}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
              <Dot tone={i.closed_tick ? 'nominal' : i.severity} pulse={!i.closed_tick} />
              <View style={{ flex: 1, gap: 1 }}>
                <T v="callout" numberOfLines={1} style={{ fontFamily: 'Geist_500Medium' }}>
                  <T v="mono" color={colors.t2}>{i.id}</T>  {i.title}
                </T>
                <T v="micro" color={colors.t3}>{INCIDENT_STATUS_LABEL[i.status]} · {formatDuration(simTime - i.opened_at_s)}</T>
              </View>
              <ChevronRight size={15} color={colors.t3} />
            </View>
          </PressableScale>
        ))}
      </View>
    </Section>
  );
}

function Spec({ spec, title = 'Specification' }: { spec?: Record<string, string | number>; title?: string }) {
  if (!spec) return null;
  return (
    <Section title={title}>
      <View>{Object.entries(spec).map(([k, v]) => <KV key={k} k={k} v={String(v)} />)}</View>
    </Section>
  );
}

/* ───────────────────────── asset ───────────────────────── */

function AssetInspector({ id }: { id: string }) {
  const asset = useWorld((s) => s.assetsById[id]) as Asset | undefined;
  const state = useWorld((s) => s.assets[id]);
  const edge = useWorld((s) => (asset?.edge_id ? s.edgesById[asset.edge_id] : undefined));
  const zone = useWorld((s) => s.topology?.zones.find((z) => z.id === asset?.zone_id));
  const select = useView((s) => s.select);
  const focus = useView((s) => s.focusEntity);
  if (!asset) return null;
  const reach = asset.accessible_by;
  const showAccess = ['valve', 'strainer', 'pump', 'sensor', 'cdu', 'port'].includes(asset.type);
  return (
    <View style={{ gap: 18 }}>
      <Header icon={<Cpu size={19} color={colors.accent} strokeWidth={2.1} />} title={asset.label} name={asset.name} status={state?.status} onClose={() => select(null)} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Focus" icon={Crosshair} size="sm" flex onPress={() => focus(id)} />
        {edge ? <Button label={edge.label} icon={Cable} size="sm" flex onPress={() => select(edge.id)} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip sm>{TYPE_LABEL[asset.type] ?? asset.type}</Chip>
        {asset.loop ? <Chip sm tone={asset.loop === 'tcs' ? 'inpipe' : 'sentinel'}>{asset.loop === 'tcs' ? 'Technology cooling' : 'Facility water'}</Chip> : null}
        {zone ? <Chip sm>{zone.name}</Chip> : null}
      </View>
      <Readings assetId={id} type={asset.type} state={state} />
      <TwinTruth state={state} edge={edge} />
      {showAccess && (
        <Section title="Robotic access">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Chip sm tone={reach.includes('outrig') ? 'outrig' : 'neutral'}>OUTRIG {reach.includes('outrig') ? 'can service' : 'no access'}</Chip>
            <Chip sm tone={reach.includes('inpipe') ? 'inpipe' : 'neutral'}>INPIPE {reach.includes('inpipe') ? 'can reach' : 'no access'}</Chip>
          </View>
        </Section>
      )}
      <Linked id={id} />
      <Spec spec={asset.spec} />
    </View>
  );
}

/* ───────────────────────── pipe ───────────────────────── */

export function SegmentStrip({ edge, state, w = 326 }: { edge: PipeEdge; state?: AssetState; w?: number }) {
  const robots = useWorld((s) => s.robots);
  const L = edge.length_m;
  const loc = state?.fault?.location_s_m;
  const occ = state?.fault?.occlusion ?? 0;
  const here = Object.values(robots).filter((r) => r.class === 'inpipe' && r.pose.segment_id === edge.id);
  const inner = w - 16;
  const px = (s: number) => 8 + (s / L) * inner;
  const fluid = edge.loop === 'tcs' ? (edge.role === 'supply' ? '#2fd3e8' : '#ff9a3c') : edge.role === 'supply' ? '#5b8dff' : '#d36bff';
  const ticks = Array.from({ length: Math.floor(L) + 1 }, (_, i) => i);
  return (
    <Svg width={w} height={64} viewBox={`0 0 ${w} 64`}>
      <Rect x={8} y={24} width={inner} height={14} rx={7} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" />
      <Rect x={9} y={26} width={inner - 2} height={10} rx={5} fill={alpha(fluid, 0.45)} />
      {ticks.map((i) => (
        <Line key={i} x1={px(i)} x2={px(i)} y1={40} y2={i % 5 === 0 ? 47 : 44} stroke="rgba(255,255,255,0.22)" />
      ))}
      {ticks.filter((i) => i % 5 === 0).map((i) => (
        <SvgText key={`t${i}`} x={px(i)} y={59} fontSize={9} fill="rgba(255,255,255,0.35)" textAnchor="middle">{i}m</SvgText>
      ))}
      {edge.access_port_ids.length > 0 && <Rect x={6} y={18} width={5} height={26} rx={2} fill="#5be3d0" />}
      {loc !== undefined && occ > 0.04 && (
        <>
          <Ellipse cx={px(loc)} cy={31} rx={6 + occ * 14} ry={5 + occ * 3} fill={`rgba(120,70,30,${0.4 + occ * 0.5})`} />
          <Path d={`M${px(loc)} 20 v-9`} stroke="#ff9a3c" strokeWidth={1.4} />
          <Circle cx={px(loc)} cy={9} r={3} fill="#ff9a3c" />
        </>
      )}
      {here.map((r) => (
        <Circle key={r.id} cx={px(r.pose.s_m ?? 0)} cy={31} r={7.5} fill="rgba(47,211,232,0.25)" />
      ))}
      {here.map((r) => (
        <Circle key={`${r.id}d`} cx={px(r.pose.s_m ?? 0)} cy={31} r={3.6} fill="#2fd3e8" />
      ))}
    </Svg>
  );
}

function PipeInspector({ id }: { id: string }) {
  const edge = useWorld((s) => s.edgesById[id]);
  const state = useWorld((s) => s.assets[id]);
  const robots = useWorld((s) => s.robots);
  const zone = useWorld((s) => s.topology?.zones.find((z) => z.id === edge?.zone_id));
  const select = useView((s) => s.select);
  const focus = useView((s) => s.focusEntity);
  if (!edge) return null;
  const crawler = Object.values(robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === id && r.mode !== 'DOCKED');
  return (
    <View style={{ gap: 18 }}>
      <Header icon={<Cable size={19} color={colors.accent} strokeWidth={2.1} />} title={edge.label} name={edge.name} status={state?.status} onClose={() => select(null)} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Focus" icon={Crosshair} size="sm" flex onPress={() => focus(id)} />
        <Button label="Pipe cam" icon={ArrowRight} size="sm" variant="primary" flex disabled={!edge.robot_passable} onPress={() => openPipeCam(id, crawler?.id)} />
      </View>
      <View style={{ gap: 8 }}>
        <SegmentStrip edge={edge} state={state} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip sm>DN{edge.diameter_mm}</Chip>
          <Chip sm>{edge.length_m.toFixed(1)} m</Chip>
          <Chip sm tone={edge.role === 'supply' ? 'inpipe' : 'outrig'}>{edge.role}</Chip>
          <Chip sm>{edge.loop === 'tcs' ? 'Technology cooling' : 'Facility water'}</Chip>
          {zone ? <Chip sm>{zone.name}</Chip> : null}
          {crawler ? <Chip sm tone="inpipe" icon={Bot}>{labelOfId(crawler.id)} inside</Chip> : null}
        </View>
      </View>
      <Readings assetId={id} type="pipe" state={state} />
      <TwinTruth state={state} edge={edge} />
      <Section title="Robotic access">
        <View style={{ flexDirection: 'row', gap: 11, padding: 13, borderRadius: 14, backgroundColor: edge.robot_passable ? 'rgba(47,211,232,0.07)' : 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: edge.robot_passable ? 'rgba(47,211,232,0.22)' : colors.line }}>
          <View style={{ paddingTop: 5 }}><Dot tone={edge.robot_passable ? 'inpipe' : 'isolated'} /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="callout" style={{ fontFamily: 'Geist_600SemiBold' }}>{edge.robot_passable ? 'Crawler-passable' : 'Not enterable'}</T>
            <T v="caption" color={colors.t2} style={{ lineHeight: 17 }}>
              {edge.robot_passable ? `Bore ${edge.diameter_mm} mm · clearance ${edge.clearance_mm} mm${edge.access_port_ids.length ? ` · port ${edge.access_port_ids.map(labelOfId).join(', ')}` : ''}` : edge.not_passable_reason}
            </T>
          </View>
        </View>
      </Section>
      <Linked id={id} />
    </View>
  );
}

/* ───────────────────────── robot ───────────────────────── */

function RobotInspector({ id }: { id: string }) {
  const r = useWorld((s) => s.robots[id]) as Robot | undefined;
  const mission = useWorld((s) => (r?.mission_id ? s.missions[r.mission_id] : undefined));
  const task = useWorld((s) => (r?.agent_task_id ? s.tasks[r.agent_task_id] : undefined));
  const select = useView((s) => s.select);
  const follow = useView((s) => s.follow);
  const following = useView((s) => s.followRobotId === id);
  if (!r) return null;
  const inpipe = r.class === 'inpipe';
  const tone: Tone = r.mode === 'DOCKED' ? 'isolated' : inpipe ? 'inpipe' : 'outrig';
  const batTone: Tone = r.battery_pct < 20 ? 'critical' : r.battery_pct < 45 ? 'warning' : 'nominal';
  return (
    <View style={{ gap: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(toneColor[inpipe ? 'inpipe' : 'outrig'], 0.14), borderWidth: 1, borderColor: alpha(toneColor[inpipe ? 'inpipe' : 'outrig'], 0.3) }}>
          <Bot size={19} color={toneColor[inpipe ? 'inpipe' : 'outrig']} strokeWidth={2.1} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <T v="headline" style={{ fontSize: 17 }}>{labelOfId(r.id)}</T>
          <T v="caption" color={colors.t3} numberOfLines={1}>{inpipe ? 'INPIPE · internal crawler' : 'OUTRIG · external maintainer'}</T>
        </View>
        <Chip tone={tone} sm leading={r.mode !== 'DOCKED' ? <Dot tone={tone} pulse size={6} /> : undefined}>{ROBOT_MODE_LABEL[r.mode]}</Chip>
        <PressableScale onPress={() => (haptic.light(), select(null))} scaleTo={0.88} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' }}>
          <X size={16} color={colors.t2} strokeWidth={2.4} />
        </PressableScale>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label={following ? 'Following' : 'Follow'} icon={Radar} size="sm" active={following} flex haptics="select" onPress={() => follow(following ? null : id)} />
        {inpipe ? <Button label="Robot cam" icon={Gauge} size="sm" variant="primary" flex disabled={!r.pose.segment_id} onPress={() => r.pose.segment_id && openPipeCam(r.pose.segment_id, id)} /> : null}
      </View>
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, columnGap: 12 }}>
          <View style={{ width: '47%' }}><Stat label="Battery" value={Math.round(r.battery_pct)} unit="%" tone={batTone === 'nominal' ? undefined : batTone} flex={false} /></View>
          <View style={{ width: '47%' }}><Stat label="Speed" value={r.pose.speed_m_s.toFixed(2)} unit="m/s" flex={false} /></View>
          <View style={{ width: '47%' }}><Stat label={r.pose.segment_id ? 'Segment' : 'Position'} value={r.pose.segment_id ? labelOfId(r.pose.segment_id) : `${r.pose.position_xyz_m[0].toFixed(1)}, ${r.pose.position_xyz_m[2].toFixed(1)}`} flex={false} /></View>
          <View style={{ width: '47%' }}><Stat label={r.pose.segment_id ? 'Along pipe' : 'Tool'} value={r.pose.segment_id ? (r.pose.s_m ?? 0).toFixed(1) : r.tool ?? 'none'} unit={r.pose.segment_id ? 'm' : undefined} flex={false} /></View>
        </View>
        <Meter value={r.battery_pct / 100} tone={batTone} />
      </View>
      {mission && (
        <Section title={`Mission · ${mission.id}`} right={<Chip sm>{Math.round(mission.progress * 100)}%</Chip>}>
          <T v="headline" style={{ fontSize: 15 }}>{mission.title}</T>
          <MissionSteps steps={mission.steps} />
        </Section>
      )}
      {task && (
        <PressableScale scaleTo={0.985} onPress={() => (haptic.light(), openIncident(task.incident_id))}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, borderRadius: 14, backgroundColor: 'rgba(167,139,250,0.08)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.24)' }}>
            <Network size={15} color={colors.sentinel} />
            <T v="callout" style={{ flex: 1 }} numberOfLines={2}>
              Agent owner · <T v="callout" style={{ fontFamily: 'Geist_700Bold' }}>{task.role.toUpperCase()}</T> · {task.title}
            </T>
            <ChevronRight size={15} color={colors.t3} />
          </View>
        </PressableScale>
      )}
      <Spec spec={r.spec} title="Hardware" />
    </View>
  );
}

export function MissionSteps({ steps }: { steps: { id: string; label: string; status: string; result?: string }[] }) {
  return (
    <View style={{ gap: 0 }}>
      {steps.map((s, i) => {
        const c = s.status === 'done' ? colors.nominal : s.status === 'active' ? colors.accent : s.status === 'failed' ? colors.critical : colors.t4;
        return (
          <View key={s.id} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ alignItems: 'center', width: 14 }}>
              <View style={{ marginTop: 5, width: 10, height: 10, borderRadius: 5, backgroundColor: s.status === 'done' || s.status === 'failed' ? c : colors.bg, borderWidth: 2, borderColor: c }}>
                {s.status === 'active' ? <View style={{ position: 'absolute', left: 1.5, top: 1.5, width: 3, height: 3, borderRadius: 2, backgroundColor: c }} /> : null}
              </View>
              {i < steps.length - 1 ? <View style={{ flex: 1, width: 2, backgroundColor: s.status === 'done' ? alpha(colors.nominal, 0.5) : 'rgba(255,255,255,0.08)', marginTop: 2 }} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: 11 }}>
              <T v="callout" color={s.status === 'pending' || s.status === 'skipped' ? colors.t3 : colors.t1} style={{ fontFamily: s.status === 'active' ? 'Geist_600SemiBold' : 'Geist_400Regular', lineHeight: 20 }}>
                {s.label}
              </T>
              {s.result ? <T v="micro" color={colors.t3}>{s.result}</T> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function Inspector({ id }: { id: string }) {
  const kind = useWorld((s) => (s.robots[id] ? 'robot' : s.edgesById[id] ? 'pipe' : s.assetsById[id] ? 'asset' : 'none'));
  if (kind === 'none') return null;
  return (
    <Animated.View key={id} entering={FadeIn.duration(200)} exiting={FadeOut.duration(100)}>
      {kind === 'robot' ? <RobotInspector id={id} /> : kind === 'pipe' ? <PipeInspector id={id} /> : <AssetInspector id={id} />}
    </Animated.View>
  );
}
