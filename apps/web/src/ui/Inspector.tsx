import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowRight, Bot, Cable, Cpu, Crosshair, Gauge, Network, Radar, ShieldAlert, X } from 'lucide-react';
import { fetchSeriesBackfill, useWorld } from '@loopkeeper/core/store';
import { READING_META, type Asset, type AssetState, type PipeEdge, type Robot } from '@loopkeeper/core/contracts';
import { INCIDENT_STATUS_LABEL, ROBOT_MODE_LABEL, STATUS_LABEL, formatDuration, labelOfId } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { Chip, Dot, Eyebrow, Meter, Sparkline, Stat, fmtReading, useSeries } from './kit';
import { useUi } from './store';

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
const toneOf = (s?: string) => (s === 'isolated' || s === 'offline' ? 'isolated' : s ?? 'nominal');

export function Inspector() {
  const id = useView((s) => s.selectedId);
  const kind = useWorld((s) => (id ? (s.robots[id] ? 'robot' : s.edgesById[id] ? 'pipe' : s.assetsById[id] ? 'asset' : 'none') : 'none'));
  return (
    <AnimatePresence mode="popLayout">
      {id && kind !== 'none' && (
        <motion.aside key={id} layout className="inspector panel" initial={{ opacity: 0, x: 18, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 18, scale: 0.98 }} transition={{ type: 'spring', stiffness: 380, damping: 34 }}>
          {kind === 'robot' ? <RobotInspector id={id} /> : kind === 'pipe' ? <PipeInspector id={id} /> : <AssetInspector id={id} />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Header({ icon, title, name, status, onClose }: { icon: React.ReactNode; title: string; name: string; status?: string; onClose: () => void }) {
  return (
    <header className="insp__head">
      <span className="insp__icon">{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="insp__title">{title}</div>
        <div className="insp__name">{name}</div>
      </div>
      {status && (
        <Chip tone={toneOf(status)} sm>
          <Dot tone={toneOf(status)} />
          {STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
        </Chip>
      )}
      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onClose} aria-label="Close inspector">
        <X size={15} />
      </button>
    </header>
  );
}

function Crumbs({ items }: { items: Array<{ label: string; onClick?: () => void }> }) {
  return (
    <div className="crumbs">
      {items.map((c, i) => (
        <span key={i} className="crumbs__i">
          {i > 0 && <span className="crumbs__sep">/</span>}
          <button onClick={c.onClick} disabled={!c.onClick}>
            {c.label}
          </button>
        </span>
      ))}
    </div>
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
    <section className="insp__sec">
      <div className="insp__secHead">
        <Eyebrow>Live readings</Eyebrow>
        {suspect.length > 0 && <Chip tone="warning" sm>suspect</Chip>}
      </div>
      <div className="readings">
        {metrics.slice(0, 4).map((m) => (
          <Stat key={m} label={READING_META[m]?.label ?? m} value={fmtReading(m, state?.readings[m])} unit={READING_META[m]?.unit} tone={suspect.includes(m) ? 'warning' : undefined} />
        ))}
      </div>
      {metrics.length > 4 && (
        <div className="readings readings--small">
          {metrics.slice(4).map((m) => (
            <div key={m} className="rd">
              <span>{READING_META[m]?.label ?? m}</span>
              <b className="num">{fmtReading(m, state?.readings[m])} <em>{READING_META[m]?.unit}</em></b>
            </div>
          ))}
        </div>
      )}
      {spark && (
        <div className="spark">
          <Sparkline data={series} w={312} h={40} color={`var(--${toneOf(state?.status) === 'nominal' ? 'accent' : toneOf(state?.status)})`} />
          <div className="spark__cap">
            <span>{READING_META[spark]?.label}</span>
            <span>last {Math.round(series.length ? series[series.length - 1][0] - series[0][0] : 0)} s sim</span>
          </div>
        </div>
      )}
    </section>
  );
}

function TwinTruth({ state, edge, asset }: { state?: AssetState; edge?: PipeEdge; asset?: Asset }) {
  const f = state?.fault;
  if (!f) return null;
  const rows: Array<[string, string]> = [];
  if (f.occlusion !== undefined) rows.push(['Bore blocked', `${Math.round(f.occlusion * 100)}%`]);
  if (f.location_s_m !== undefined && edge) rows.push(['Deposit location', `s = ${f.location_s_m.toFixed(1)} m of ${edge.length_m.toFixed(1)} m`]);
  if (f.opening !== undefined) rows.push(['Effective opening', `${Math.round(f.opening * 100)}% (commanded ${Math.round((f.commanded_opening ?? 0.85) * 100)}%)`]);
  if (f.health !== undefined) rows.push(['Pump health', `${Math.round(f.health * 100)}%`]);
  if (!rows.length) return null;
  void asset;
  return (
    <section className="insp__sec insp__truth">
      <div className="insp__secHead">
        <Eyebrow>Simulator truth</Eyebrow>
        <Chip sm tone="sentinel" title="Hidden from the agents — they must discover it by inspection.">
          <ShieldAlert size={10} /> twin only
        </Chip>
      </div>
      <div className="kvs">
        {rows.map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

function Linked({ id }: { id: string }) {
  const incidents = useWorld(useShallow((s) => Object.values(s.incidents).filter((i) => i.anchor.entity_id === id || i.affected_asset_ids.includes(id)).sort((a, b) => b.opened_tick - a.opened_tick).slice(0, 3)));
  const pin = useUi((s) => s.pin);
  const simTime = useWorld((s) => s.simTimeS);
  if (!incidents.length) return null;
  return (
    <section className="insp__sec">
      <Eyebrow style={{ marginBottom: 8 }}>Linked incidents</Eyebrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {incidents.map((i) => (
          <button key={i.id} className="linkrow" onClick={() => pin(i.id)}>
            <Dot tone={i.closed_tick ? 'nominal' : i.severity} pulse={!i.closed_tick} />
            <span className="mono" style={{ fontWeight: 600 }}>{i.id}</span>
            <span style={{ color: 'var(--t2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{i.title}</span>
            <span style={{ color: 'var(--t3)', fontSize: 11 }}>{INCIDENT_STATUS_LABEL[i.status]} · {formatDuration(simTime - i.opened_at_s)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Spec({ spec }: { spec?: Record<string, string | number> }) {
  if (!spec) return null;
  return (
    <section className="insp__sec">
      <Eyebrow style={{ marginBottom: 8 }}>Specification</Eyebrow>
      <div className="kvs">
        {Object.entries(spec).map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{String(v)}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────── asset ───────────── */

function AssetInspector({ id }: { id: string }) {
  const asset = useWorld((s) => s.assetsById[id]);
  const state = useWorld((s) => s.assets[id]);
  const zones = useWorld((s) => s.topology?.zones);
  const select = useView((s) => s.select);
  const focus = useView((s) => s.focusEntity);
  const zone = zones?.find((z) => z.id === asset?.zone_id);
  const edge = useWorld((s) => (asset?.edge_id ? s.edgesById[asset.edge_id] : undefined));
  if (!asset) return null;
  const reach = asset.accessible_by;
  return (
    <>
      <Header icon={<Cpu size={16} />} title={asset.label} name={asset.name} status={state?.status} onClose={() => select(null)} />
      <Crumbs items={[{ label: 'Facility', onClick: () => useView.getState().resetCamera() }, ...(zone ? [{ label: zone.name, onClick: () => focus(zone.id) }] : []), ...(edge ? [{ label: edge.label, onClick: () => select(edge.id) }] : []), { label: asset.label }]} />
      <div className="insp__scroll scroll">
        <section className="insp__sec" style={{ paddingTop: 4 }}>
          <div className="chips-row">
            <Chip sm>{TYPE_LABEL[asset.type] ?? asset.type}</Chip>
            {asset.loop && <Chip sm tone={asset.loop === 'tcs' ? 'inpipe' : 'sentinel'}>{asset.loop === 'tcs' ? 'Technology cooling' : 'Facility water'}</Chip>}
          </div>
        </section>
        <Readings assetId={id} type={asset.type} state={state} />
        <TwinTruth state={state} edge={edge} asset={asset} />
        {(asset.type === 'valve' || asset.type === 'strainer' || asset.type === 'pump' || asset.type === 'sensor' || asset.type === 'cdu' || asset.type === 'port') && (
          <section className="insp__sec">
            <Eyebrow style={{ marginBottom: 8 }}>Robotic access</Eyebrow>
            <div className="chips-row">
              <Chip sm tone={reach.includes('outrig') ? 'outrig' : undefined}>OUTRIG {reach.includes('outrig') ? 'can service' : 'no access'}</Chip>
              <Chip sm tone={reach.includes('inpipe') ? 'inpipe' : undefined}>INPIPE {reach.includes('inpipe') ? 'can reach' : 'no access'}</Chip>
            </div>
          </section>
        )}
        <Linked id={id} />
        <Spec spec={asset.spec} />
      </div>
      <footer className="insp__foot">
        <button className="btn btn--sm" onClick={() => focus(id)}>
          <Crosshair size={13} /> Focus
        </button>
        {edge && (
          <button className="btn btn--sm" onClick={() => select(edge.id)}>
            <Cable size={13} /> {edge.label}
          </button>
        )}
      </footer>
    </>
  );
}

/* ───────────── pipe ───────────── */

export function SegmentStrip({ edge, state }: { edge: PipeEdge; state?: AssetState }) {
  const robots = useWorld((s) => s.robots);
  const L = edge.length_m;
  const loc = state?.fault?.location_s_m;
  const occ = state?.fault?.occlusion ?? 0;
  const here = Object.values(robots).filter((r) => r.class === 'inpipe' && r.pose.segment_id === edge.id);
  const px = (s: number) => 8 + (s / L) * 304;
  return (
    <svg width="320" height="62" viewBox="0 0 320 62" className="strip" role="img" aria-label={`Segment ${edge.label} schematic`}>
      <rect x="8" y="24" width="304" height="14" rx="7" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.1)" />
      <rect x="9" y="26" width="302" height="10" rx="5" fill={edge.loop === 'tcs' ? (edge.role === 'supply' ? 'rgba(47,211,232,.45)' : 'rgba(255,154,60,.45)') : edge.role === 'supply' ? 'rgba(91,141,255,.45)' : 'rgba(211,107,255,.4)'} />
      {Array.from({ length: Math.floor(L) + 1 }).map((_, i) => (
        <g key={i}>
          <line x1={px(i)} x2={px(i)} y1="40" y2={i % 5 === 0 ? 47 : 44} stroke="rgba(255,255,255,.22)" />
          {i % 5 === 0 && <text x={px(i)} y="58" fontSize="9" fill="rgba(255,255,255,.35)" textAnchor="middle" fontFamily="var(--mono)">{i}m</text>}
        </g>
      ))}
      {edge.access_port_ids.length > 0 && <rect x="6" y="18" width="5" height="26" rx="2" fill="#5be3d0" />}
      {loc !== undefined && occ > 0.04 && (
        <g>
          <ellipse cx={px(loc)} cy="31" rx={6 + occ * 14} ry={5 + occ * 3} fill={`rgba(120,70,30,${0.4 + occ * 0.5})`} />
          <path d={`M${px(loc)} 20 v-9`} stroke="#ff9a3c" strokeWidth="1.4" />
          <circle cx={px(loc)} cy="9" r="3" fill="#ff9a3c" />
        </g>
      )}
      {here.map((r) => (
        <g key={r.id} transform={`translate(${px(r.pose.s_m ?? 0)},31)`}>
          <circle r="7.5" fill="rgba(47,211,232,.25)" />
          <circle r="3.6" fill="#2fd3e8" />
        </g>
      ))}
    </svg>
  );
}

/** Real topology ids for a segment: what it is, what is upstream/downstream, and what the solver says right now. */
function NetworkIds({ edge, state }: { edge: PipeEdge; state: AssetState | undefined }) {
  const x = edge as PipeEdge & { circuit_id?: string; service_access?: unknown; maintenance_access?: string };
  const r = state?.readings ?? {};
  const flow = r.flow_kg_s;
  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: 'contents' }}>
      <span style={{ color: 'var(--t3)' }}>{k}</span>
      <b className="mono" style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{v}</b>
    </div>
  );
  return (
    <section className="insp__sec">
      <Eyebrow style={{ marginBottom: 8 }}>Network ids</Eyebrow>
      <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: '3px 8px', fontSize: 11.5 }}>
        {row('edge_id', edge.id)}
        {row('loop', `${edge.loop}${x.circuit_id ? ` · ${x.circuit_id}` : ''} · ${edge.role}`)}
        {row('upstream node', edge.from)}
        {row('downstream node', edge.to)}
        {row('length · bore', `${edge.length_m.toFixed(2)} m · DN${edge.diameter_mm}`)}
        {row('signed flow', flow === undefined ? 'no reading' : `${flow >= 0 ? '+' : '−'}${Math.abs(flow).toFixed(2)} kg/s (${flow >= 0 ? 'with' : 'against'} from→to)`)}
        {row('pressure', r.pressure_kpa === undefined ? 'no reading' : `${r.pressure_kpa.toFixed(1)} kPa`)}
        {r.temperature_c !== undefined && row('temperature', `${r.temperature_c.toFixed(1)} °C`)}
        {row('access', edge.robot_passable ? 'crawler-serviceable' : `not crawler-serviceable${edge.not_passable_reason ? ` (${edge.not_passable_reason})` : ''}`)}
        {x.maintenance_access && row('maintenance', x.maintenance_access)}
      </div>
    </section>
  );
}

function PipeInspector({ id }: { id: string }) {
  const edge = useWorld((s) => s.edgesById[id]);
  const state = useWorld((s) => s.assets[id]);
  const select = useView((s) => s.select);
  const focus = useView((s) => s.focusEntity);
  const enterPipe = useView((s) => s.enterPipe);
  const zones = useWorld((s) => s.topology?.zones);
  const robots = useWorld((s) => s.robots);
  if (!edge) return null;
  const zone = zones?.find((z) => z.id === edge.zone_id);
  const crawler = Object.values(robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === id && r.mode !== 'DOCKED');
  return (
    <>
      <Header icon={<Cable size={16} />} title={edge.label} name={edge.name} status={state?.status} onClose={() => select(null)} />
      <Crumbs items={[{ label: 'Facility', onClick: () => useView.getState().resetCamera() }, { label: edge.loop === 'tcs' ? 'Technology cooling' : 'Facility water' }, ...(zone ? [{ label: zone.name, onClick: () => focus(zone.id) }] : []), { label: edge.label }]} />
      <div className="insp__scroll scroll">
        <section className="insp__sec" style={{ paddingTop: 4 }}>
          <SegmentStrip edge={edge} state={state} />
          <div className="chips-row" style={{ marginTop: 6 }}>
            <Chip sm>DN{edge.diameter_mm}</Chip>
            <Chip sm>{edge.length_m.toFixed(1)} m</Chip>
            <Chip sm tone={edge.role === 'supply' ? 'inpipe' : 'outrig'}>{edge.role}</Chip>
            {crawler && <Chip sm tone="inpipe"><Bot size={10} /> {labelOfId(crawler.id)} inside</Chip>}
          </div>
        </section>
        <NetworkIds edge={edge} state={state} />
        <Readings assetId={id} type="pipe" state={state} />
        <TwinTruth state={state} edge={edge} />
        <section className="insp__sec">
          <Eyebrow style={{ marginBottom: 8 }}>Robotic access</Eyebrow>
          {edge.robot_passable ? (
            <div className="access access--ok">
              <Dot tone="inpipe" />
              <div>
                <b>Crawler-passable</b>
                <span>Bore {edge.diameter_mm} mm · clearance {edge.clearance_mm} mm{edge.access_port_ids.length ? ` · port ${edge.access_port_ids.map(labelOfId).join(', ')}` : ''}</span>
              </div>
            </div>
          ) : (
            <div className="access access--no">
              <Dot tone="isolated" />
              <div>
                <b>Not enterable</b>
                <span>{edge.not_passable_reason}</span>
              </div>
            </div>
          )}
        </section>
        <Linked id={id} />
      </div>
      <footer className="insp__foot">
        <button className="btn btn--sm" onClick={() => focus(id)}>
          <Crosshair size={13} /> Focus
        </button>
        <button className="btn btn--sm btn--primary" disabled={!edge.robot_passable} title={edge.robot_passable ? 'Look inside the bore' : edge.not_passable_reason} onClick={() => enterPipe(id, crawler?.id ?? null)}>
          <ArrowRight size={13} /> Enter pipe
        </button>
      </footer>
    </>
  );
}

/* ───────────── robot ───────────── */

function RobotInspector({ id }: { id: string }) {
  const r = useWorld((s) => s.robots[id]) as Robot;
  const mission = useWorld((s) => (r?.mission_id ? s.missions[r.mission_id] : undefined));
  const task = useWorld((s) => (r?.agent_task_id ? s.tasks[r.agent_task_id] : undefined));
  const select = useView((s) => s.select);
  const follow = useView((s) => s.follow);
  const following = useView((s) => s.followRobotId === id);
  const enterPipe = useView((s) => s.enterPipe);
  const setMode = useView((s) => s.setMode);
  const setTask = useUi((s) => s.setTask);
  const series = useMemo(() => [] as Array<[number, number]>, []);
  void series;
  if (!r) return null;
  const tone = r.mode === 'DOCKED' ? 'isolated' : r.class === 'inpipe' ? 'inpipe' : 'outrig';
  return (
    <>
      <header className="insp__head">
        <span className={`insp__icon tone-${r.class === 'inpipe' ? 'inpipe' : 'outrig'}`}><Bot size={16} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="insp__title">{labelOfId(r.id)}</div>
          <div className="insp__name">{r.class === 'inpipe' ? 'INPIPE · internal inspection crawler' : 'OUTRIG · external maintenance robot'}</div>
        </div>
        <Chip tone={tone} sm>{r.mode !== 'DOCKED' && <Dot tone={tone} pulse />}{ROBOT_MODE_LABEL[r.mode]}</Chip>
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => select(null)} aria-label="Close inspector"><X size={15} /></button>
      </header>
      <div className="insp__scroll scroll">
        <section className="insp__sec" style={{ paddingTop: 8 }}>
          <div className="readings">
            <Stat label="Battery" value={Math.round(r.battery_pct)} unit="%" tone={r.battery_pct < 20 ? 'critical' : r.battery_pct < 45 ? 'warning' : undefined} />
            <Stat label="Speed" value={r.pose.speed_m_s.toFixed(2)} unit="m/s" />
            <Stat label={r.pose.segment_id ? 'Segment' : 'Position'} value={r.pose.segment_id ? labelOfId(r.pose.segment_id) : `${r.pose.position_xyz_m[0].toFixed(1)}, ${r.pose.position_xyz_m[2].toFixed(1)}`} />
            <Stat label={r.pose.segment_id ? 'Along pipe' : 'Tool'} value={r.pose.segment_id ? (r.pose.s_m ?? 0).toFixed(1) : r.tool ?? 'none'} unit={r.pose.segment_id ? 'm' : undefined} />
          </div>
          <Meter value={r.battery_pct / 100} tone={r.battery_pct < 20 ? 'critical' : r.battery_pct < 45 ? 'warning' : 'nominal'} style={{ marginTop: 12 }} />
        </section>
        {mission && (
          <section className="insp__sec">
            <div className="insp__secHead">
              <Eyebrow>Mission · {mission.id}</Eyebrow>
              <Chip sm>{Math.round(mission.progress * 100)}%</Chip>
            </div>
            <div className="mtitle">{mission.title}</div>
            <ol className="msteps">
              {mission.steps.map((s) => (
                <li key={s.id} data-status={s.status}>
                  <i />
                  <span>{s.label}</span>
                  {s.result && <em>{s.result}</em>}
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="insp__sec">
          <Eyebrow style={{ marginBottom: 8 }}>Hardware</Eyebrow>
          <div className="kvs">
            {Object.entries(r.spec).map(([k, v]) => (
              <div key={k}>
                <span>{k}</span>
                <b>{String(v)}</b>
              </div>
            ))}
          </div>
        </section>
        {task && (
          <section className="insp__sec">
            <button
              className="linkrow"
              onClick={() => {
                setTask(task.id);
                useView.getState().focusIncident(task.incident_id);
                setMode('agents');
              }}
            >
              <Network size={14} className="tone-sentinel" />
              <span style={{ flex: 1, textAlign: 'left' }}>Agent owner · <b>{task.role.toUpperCase()}</b> · {task.title}</span>
              <ArrowRight size={13} />
            </button>
          </section>
        )}
      </div>
      <footer className="insp__foot">
        <button className="btn btn--sm" data-on={following} onClick={() => follow(following ? null : id)}>
          <Radar size={13} /> {following ? 'Following' : 'Follow'}
        </button>
        {r.class === 'inpipe' && (
          <button className="btn btn--sm btn--primary" disabled={!r.pose.segment_id} onClick={() => r.pose.segment_id && enterPipe(r.pose.segment_id, id)}>
            <Gauge size={13} /> Robot cam
          </button>
        )}
      </footer>
    </>
  );
}
