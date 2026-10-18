import { AnimatePresence, motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, Eye, EyeOff, History, Layers, Radar, TriangleAlert, X } from 'lucide-react';
import { useWorld, selectIncidentsSorted, useReplay, enterReplay, exitReplay } from '@loopkeeper/core/store';
import { INCIDENT_STATUS_LABEL, ROBOT_MODE_LABEL, STAGE_LABEL, formatDuration, labelOfId } from '@loopkeeper/core';
import { STAGES, type Incident, type Robot } from '@loopkeeper/core/contracts';
import { useView, type Layers as LayerState } from '@loopkeeper/scene';
import { Chip, Dot, Eyebrow, Meter, Segmented } from './kit';
import { useUi, type PanelId } from './store';
import { Button, IconButton } from './kit/index';

const ITEMS: Array<{ id: Exclude<PanelId, null>; icon: typeof Layers; label: string }> = [
  { id: 'layers', icon: Layers, label: 'Layers & views' },
  { id: 'fleet', icon: Bot, label: 'Robot fleet' },
  { id: 'incidents', icon: TriangleAlert, label: 'Incidents' },
];

export function Dock() {
  const panel = useUi((s) => s.panel);
  const toggle = useUi((s) => s.togglePanel);
  const open = useWorld((s) => s.kpis?.open_incidents ?? 0);
  const replay = useReplay((s) => s.active);
  const toggleReplay = () => (replay ? void exitReplay() : enterReplay());
  return (
    <nav className="dock panel panel--tight" aria-label="Workspace">
      {ITEMS.map((it) => (
        <button key={it.id} className="dock__btn" data-active={panel === it.id} aria-pressed={panel === it.id} onClick={() => toggle(it.id)} title={it.label} aria-label={it.label}>
          <it.icon size={18} strokeWidth={1.8} />
          {it.id === 'incidents' && open > 0 && <i className="dock__badge">{open}</i>}
        </button>
      ))}
      <span className="dock__sep" />
      <button className="dock__btn" data-active={replay} aria-pressed={replay} onClick={toggleReplay} title="Replay recent history" aria-label="Replay">
        <History size={18} strokeWidth={1.8} />
      </button>
    </nav>
  );
}

export function SidePanel() {
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  return (
    <AnimatePresence mode="wait">
      {panel && (
        <motion.aside key={panel} className="sidepanel panel" initial={{ opacity: 0, x: -14, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
          <div className="sidepanel__head">
            <Eyebrow>{panel === 'layers' ? 'Layers & views' : panel === 'fleet' ? 'Robot fleet' : 'Incidents'}</Eyebrow>
            <IconButton size="sm" onClick={() => setPanel(null)} aria-label="Close panel" icon={<X size={15} />} />
          </div>
          <div className="sidepanel__body scroll">{panel === 'layers' ? <LayersPanel /> : panel === 'fleet' ? <FleetPanel /> : <IncidentsPanel />}</div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* ───────────── layers ───────────── */

const GROUPS: Array<{ title: string; items: Array<[keyof LayerState, string, string]> }> = [
  { title: 'Structure', items: [['walls', 'Full-height walls', 'Raise the shell — near walls cut away automatically'], ['roof', 'Roof', 'Glass roof panels'], ['floor', 'Floor slab', ''], ['service', 'Service bays & markings', 'Reserved rack bays, safety lines']] },
  { title: 'Cooling networks', items: [['technology_cooling', 'Technology cooling (TCS)', 'Secondary loop · rack side'], ['facility_water', 'Facility water (FWS)', 'Primary loop · chiller side'], ['flow', 'Flow tracers', 'Speed follows measured velocity'], ['thermal', 'Thermal overlay', 'Rack heat plumes']] },
  { title: 'Actors & labels', items: [['robots', 'Robots', ''], ['sensors', 'Sensors', ''], ['labels', 'Callouts', 'Incident & hover labels']] },
];

function LayersPanel() {
  const layers = useView((s) => s.layers);
  const setLayer = useView((s) => s.setLayer);
  const xray = useView((s) => s.xray);
  const toggleX = useView((s) => s.toggleXray);
  const preset = useView((s) => s.preset);
  return (
    <>
      <Eyebrow style={{ marginBottom: 8 }}>Camera</Eyebrow>
      <div className="preset-grid">
        {([
          ['structure', 'Structure Cutaway'],
          ['exterior', 'Exterior'],
          ['cooling', 'Cooling Network'],
          ['racks', 'Rack Zone'],
          ['plant', 'Mechanical Plant'],
          ['pipe', 'Pipe Interior'],
        ] as const).map(([id, label]) => (
          <Button key={id} size="sm" className="preset" onClick={() => preset(id)}>{label}</Button>
        ))}
      </div>
      <div className="row-switch" style={{ marginTop: 14 }}>
        <div>
          <div className="row-switch__t">X-ray</div>
          <div className="row-switch__s">Shell recedes, equipment stays legible</div>
        </div>
        <Switch on={xray} onChange={toggleX} label="X-ray" />
      </div>
      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginTop: 18 }}>
          <Eyebrow style={{ marginBottom: 4 }}>{g.title}</Eyebrow>
          {g.items.map(([k, label, sub]) => (
            <div className="row-switch" key={k}>
              <div style={{ minWidth: 0 }}>
                <div className="row-switch__t" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {layers[k] ? <Eye size={13} style={{ color: 'var(--t3)' }} /> : <EyeOff size={13} style={{ color: 'var(--t4)' }} />} {label}
                </div>
                {sub && <div className="row-switch__s">{sub}</div>}
              </div>
              <Switch on={layers[k]} onChange={() => setLayer(k, !layers[k])} label={label} />
            </div>
          ))}
        </div>
      ))}
      <div className="legend">
        <Eyebrow style={{ marginBottom: 8 }}>Fluid colours</Eyebrow>
        {[
          ['#00d8f6', 'TCS supply'],
          ['#f59e0b', 'TCS return (heat)'],
          ['#2563eb', 'FWS supply'],
          ['#475569', 'FWS return'],
        ].map(([c, l]) => (
          <span key={l} className="legend__i"><i style={{ background: c }} />{l}</span>
        ))}
      </div>
    </>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={onChange}>
      <i />
    </button>
  );
}

/* ───────────── fleet ───────────── */

function BatteryRing({ pct }: { pct: number }) {
  const tone = pct < 20 ? 'critical' : pct < 45 ? 'warning' : 'nominal';
  return <span className={`tone-${tone} num`} style={{ fontSize: 11, fontWeight: 600 }}>{Math.round(pct)}%</span>;
}

function RobotCard({ r }: { r: Robot }) {
  const select = useView((s) => s.select);
  const selected = useView((s) => s.selectedId === r.id);
  const follow = useView((s) => s.follow);
  const following = useView((s) => s.followRobotId === r.id);
  const enterPipe = useView((s) => s.enterPipe);
  const mission = useWorld((s) => (r.mission_id ? s.missions[r.mission_id] : undefined));
  const tone = r.mode === 'DOCKED' || r.mode === 'IDLE' ? 'isolated' : r.mode === 'BLOCKED' || r.mode === 'FAILED' ? 'critical' : r.class === 'inpipe' ? 'inpipe' : 'outrig';
  const active = r.mode !== 'DOCKED';
  return (
    <div className="rcard" data-selected={selected} onClick={() => select(r.id)}>
      <div className="rcard__top">
        <span className={`rcard__icon tone-${r.class === 'inpipe' ? 'inpipe' : 'outrig'}`}><Bot size={15} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="rcard__name">{labelOfId(r.id)}</div>
          <div className="rcard__sub">{r.class === 'inpipe' ? 'Internal inspection' : 'External maintenance'}</div>
        </div>
        <Chip tone={tone} sm>{active && <Dot tone={tone} pulse />}{ROBOT_MODE_LABEL[r.mode]}</Chip>
      </div>
      <div className="rcard__meta">
        <span>Battery <BatteryRing pct={r.battery_pct} /></span>
        <span>{r.pose.segment_id ? `${labelOfId(r.pose.segment_id)} · ${(r.pose.s_m ?? 0).toFixed(1)} m` : `x ${r.pose.position_xyz_m[0].toFixed(1)} · z ${r.pose.position_xyz_m[2].toFixed(1)}`}</span>
      </div>
      <Meter value={r.battery_pct / 100} tone={r.battery_pct < 20 ? 'critical' : r.battery_pct < 45 ? 'warning' : 'nominal'} style={{ marginTop: 8 }} />
      {mission && <div className="rcard__mission">{mission.title}</div>}
      <div className="rcard__actions">
        <Button size="sm" icon={<Radar size={13} />} pressed={following} onClick={(e) => (e.stopPropagation(), follow(following ? null : r.id))}>
          {following ? 'Following' : 'Follow'}
        </Button>
        {r.class === 'inpipe' && (
          <Button size="sm" disabledReason={r.pose.segment_id ? undefined : 'Crawler is not inside a pipe segment'} onClick={(e) => (e.stopPropagation(), r.pose.segment_id && enterPipe(r.pose.segment_id, r.id))}>
            Robot cam
          </Button>
        )}
      </div>
    </div>
  );
}

function FleetPanel() {
  const robots = useWorld((s) => s.robots);
  const [tab, setTab] = useTab();
  const list = Object.values(robots).filter((r) => (tab === 'inpipe' ? r.class === 'inpipe' : r.class === 'outrig'));
  const n = (c: string) => Object.values(robots).filter((r) => r.class === c).length;
  return (
    <>
      <Segmented small group="fleet" value={tab} onChange={setTab} items={[{ id: 'inpipe', label: `Internal · ${n('inpipe')}` }, { id: 'outrig', label: `External · ${n('outrig')}` }]} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
        {list.map((r) => <RobotCard key={r.id} r={r} />)}
      </div>
      <div className="note">Virtual robots — poses and missions come from the simulator, never from the UI.</div>
    </>
  );
}

import { useState } from 'react';
function useTab() {
  return useState<'inpipe' | 'outrig'>('inpipe');
}

/* ───────────── incidents ───────────── */

export function StageDots({ inc, compact }: { inc: Incident; compact?: boolean }) {
  const idx = STAGES.indexOf(inc.stage);
  const rejected = inc.stage_log.some((l) => l.outcome === 'rejected');
  return (
    <div className={`stages${compact ? ' stages--compact' : ''}`}>
      {STAGES.map((s, i) => {
        const done = i < idx || (i === idx && (inc.status === 'resolved' || inc.status === 'dismissed'));
        const cur = i === idx && !done;
        return (
          <div key={s} className="stages__item" data-done={done} data-cur={cur}>
            <i className="stages__node" />
            {!compact && <span className="stages__label">{STAGE_LABEL[s]}</span>}
            {i < STAGES.length - 1 && <b className="stages__bar" data-fill={i < idx || done} />}
          </div>
        );
      })}
      {rejected && !compact && <span className="stages__retry" title="A repair was rejected by the verifier and replanned">↺ replanned</span>}
    </div>
  );
}

function IncidentsPanel() {
  const incidents = useWorld(useShallow(selectIncidentsSorted));
  const simTime = useWorld((s) => s.simTimeS);
  const pin = useUi((s) => s.pin);
  const focus = useView((s) => s.focusIncident);
  if (!incidents.length)
    return (
      <div className="empty">
        <Dot tone="nominal" pulse />
        <div className="empty__t">All systems nominal</div>
        <div className="empty__s">No incidents yet. Faults arrive from seeded wear in the simulated plant — SENTINEL is watching.</div>
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {incidents.map((i) => {
        const closed = !!i.closed_tick;
        const tone = closed ? (i.status === 'dismissed' ? 'isolated' : 'nominal') : i.status === 'escalated' ? 'critical' : i.severity;
        return (
          <button key={i.id} className="icard" data-closed={closed} onClick={() => (pin(i.id), focus(i.id))}>
            <div className="icard__top">
              <Dot tone={tone} pulse={!closed} />
              <span className="icard__id mono">{i.id}</span>
              <span className="icard__time">{formatDuration(simTime - i.opened_at_s)} ago</span>
              <Chip tone={closed ? tone : 'accent'} sm>{INCIDENT_STATUS_LABEL[i.status]}</Chip>
            </div>
            <div className="icard__title">{i.title}</div>
            <StageDots inc={i} compact />
          </button>
        );
      })}
    </div>
  );
}
