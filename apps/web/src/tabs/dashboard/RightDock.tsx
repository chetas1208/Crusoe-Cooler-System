import { useSupervisors } from '../../lib/supervisors';
import { useMemo } from 'react';
import { Bot, Check, Wrench } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useWorld, type FeedItem } from '@loopkeeper/core/store';
import { CAUSE_LABEL, INCIDENT_STATUS_LABEL, ROBOT_MODE_LABEL, formatDuration, formatSimClock, labelOfId } from '@loopkeeper/core';
import type { Incident, Robot } from '@loopkeeper/core/contracts';
import { entityFocus, useMapCamera, useView } from '@loopkeeper/scene';
import { Chip } from '../../ui/kit';
import { useUi, usePinnedIncident } from '../../ui/store';

const sevTone = (i: Incident) => (i.closed_tick ? (i.status === 'dismissed' ? 'isolated' : 'nominal') : i.status === 'escalated' ? 'critical' : i.severity);

/** Jump to the Map tab with this incident's hardware selected and framed. */
export function locateInMap(inc: Incident) {
  const w = useWorld.getState();
  const mission = inc.mission_ids.map((id) => w.missions[id]).find((m) => m && !m.closed_tick);
  const robot = mission ? w.robots[mission.robot_id] : undefined;
  const view = useView.getState();
  view.select(inc.anchor.entity_id);
  view.focusIncident(inc.id);
  if (robot) useMapCamera.getState().selectRobot(robot.id, robot.class);
  // frame the incident's hardware in the Map's tactical view ("Whole facility" returns to the overview)
  const f = entityFocus(inc.anchor.entity_id);
  if (f) useMapCamera.getState().setTactical({ azimuth: 0.58, elevation: 0.7, distance: Math.min(Math.max(f.distance * 1.5, 12), 22), target: f.target, fov: 32 });
  useUi.getState().pin(inc.id);
  useUi.getState().setTab('map');
}

function TopIncident() {
  const inc = usePinnedIncident();
  const simTime = useWorld((s) => s.simTimeS);
  const setTab = useUi((s) => s.setTab);
  if (!inc || inc.closed_tick) {
    return (
      <div className="dd__quiet" role="status">
        <Check size={14} strokeWidth={2.4} />
        <span>No active cooling incidents</span>
      </div>
    );
  }
  const tone = sevTone(inc);
  return (
    <article className="dd__inc" data-tone={tone}>
      <header>
        <span className="mono dd__id">{inc.id}</span>
        <span className="dd__muted">open {formatDuration(simTime - inc.opened_at_s)}</span>
      </header>
      <h3>{inc.title}</h3>
      <div className="dd__chips">
        <Chip tone={tone} sm>{inc.status === 'escalated' ? 'Needs operator' : INCIDENT_STATUS_LABEL[inc.status]}</Chip>
        <Chip sm>{CAUSE_LABEL[inc.cause]}</Chip>
      </div>
      <p>{inc.summary}</p>
      <div className="dd__actions">
        <button className="btn btn--sm btn--primary" onClick={() => locateInMap(inc)}>Locate in Map</button>
        <button className="btn btn--sm btn--ghost" onClick={() => (useUi.getState().pin(inc.id), useView.getState().focusIncident(inc.id), setTab('agents'))}>Open in Agents</button>
      </div>
    </article>
  );
}

const MODE_TONE = (r: Robot) => (r.mode === 'FAILED' || r.mode === 'BLOCKED' || r.mode === 'SAFE_HOLD' || r.mode === 'ABORTED' ? 'critical' : r.mode === 'NEEDS_CHARGE' ? 'warning' : r.mode === 'DOCKED' || r.mode === 'IDLE' ? undefined : r.class === 'inpipe' ? 'inpipe' : 'outrig');

function Robots() {
  const robots = useWorld(useShallow((s) => Object.values(s.robots)));
  const missions = useWorld((s) => s.missions);
  const selected = useView((s) => s.selectedId);
  const inpipeCount = robots.filter((r) => r.class === 'inpipe').length;
  const outrigCount = robots.filter((r) => r.class === 'outrig').length;
  const sup = useSupervisors();
  const supervisorCount = sup.list.length;
  const sorted = useMemo(() => [...robots].sort((a, b) => Number(b.mode !== 'DOCKED' && b.mode !== 'IDLE') - Number(a.mode !== 'DOCKED' && a.mode !== 'IDLE') || a.id.localeCompare(b.id)), [robots]);
  const shown = sorted.slice(0, 4);
  if (!robots.length) return <p className="dd__empty">No robots reported by this backend.</p>;
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 11,
          padding: '6px 10px',
          background: 'rgba(255, 255, 255, 0.04)',
          borderRadius: 6,
          marginBottom: 8,
          color: 'var(--t2)',
        }}
      >
        <span><strong style={{ color: '#2fd3e8' }}>{inpipeCount}</strong> internal</span>
        <span>·</span>
        <span><strong style={{ color: '#ff9a3c' }}>{outrigCount}</strong> external</span>
        <span>·</span>
        <span><strong style={{ color: '#a78bfa' }}>{sup.loaded ? supervisorCount : '…'}</strong> supervisors</span>
      </div>
      <ul className="dd__list">

      {shown.map((r) => {
        const m = r.mission_id ? missions[r.mission_id] : undefined;
        const Icon = r.class === 'inpipe' ? Bot : Wrench;
        return (
          <li key={r.id}>
            <button className="dd__row" data-selected={selected === r.id} onClick={() => (useView.getState().select(r.id), useView.getState().focusEntity(r.id))}>
              <span className={`dd__ico tone-${r.class === 'inpipe' ? 'inpipe' : 'outrig'}`}><Icon size={14} /></span>
              <span className="dd__main">
                <b>{labelOfId(r.id)}</b>
                <span className="dd__muted">{m ? `${m.title}` : r.mode === 'DOCKED' ? `Docked at ${labelOfId(r.home_id)}` : ROBOT_MODE_LABEL[r.mode]}</span>
              </span>
              <span className="dd__end">
                <Chip tone={MODE_TONE(r)} sm>{ROBOT_MODE_LABEL[r.mode]}</Chip>
                <span className="num dd__muted">{Math.round(r.battery_pct)}%</span>
              </span>
            </button>
          </li>
        );
      })}
      {sorted.length > shown.length && <li className="dd__muted dd__more">+{sorted.length - shown.length} more in Map</li>}
    </ul>
    </>
  );
}


const CONSEQ = (f: FeedItem) => f.kind === 'incident' || f.kind === 'verify' || f.kind === 'approval' || f.severity === 'warning' || f.severity === 'critical';

function Events() {
  const feed = useWorld((s) => s.feed);
  const items = useMemo(() => feed.filter(CONSEQ).slice(0, 4), [feed]);
  if (!items.length) return <p className="dd__empty">No incident, approval or verification events yet.</p>;
  return (
    <ul className="dd__list">
      {items.map((f) => {
        const tone = f.severity === 'ok' ? 'nominal' : f.severity === 'info' ? 'accent' : f.severity;
        const go = () => (f.incidentId ? (useUi.getState().pin(f.incidentId), useView.getState().focusIncident(f.incidentId)) : f.assetId ? useView.getState().focusEntity(f.assetId) : undefined);
        return (
          <li key={f.id}>
            <button className="dd__row dd__row--ev" onClick={go}>
              <span className={`dd__dot tone-${tone}`} />
              <span className="dd__main">
                <span className="dd__evtext">{f.text}</span>
                <span className="dd__muted mono">T+{formatSimClock(f.simTimeS)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Right dock: the one thing that needs attention, who is working on it, and what just happened. */
export function RightDock() {
  return (
    <aside className="dd panel" data-inset="right" aria-label="Operations summary">
      <section>
        <TopIncident />
      </section>
      <section>
        <h2>Robots</h2>
        <Robots />
      </section>
      <section className="dd__events">
        <h2>Recent events</h2>
        <Events />
      </section>
    </aside>
  );
}
