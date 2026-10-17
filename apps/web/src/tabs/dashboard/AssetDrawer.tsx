import { X } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { ROBOT_MODE_LABEL, STATUS_LABEL, formatReading, labelOfId } from '@loopkeeper/core';
import type { AssetStatus } from '@loopkeeper/core/contracts';
import { useMapCamera, useView } from '@loopkeeper/scene';
import { Chip, Meter } from '../../ui/kit';
import { EntityIds, FlyButton } from '../../ui/EntityIds';
import { useUi } from '../../ui/store';

const KEYS: Record<string, string[]> = {
  rack: ['margin_k', 'power_kw', 'flow_kg_s', 't_out_c'],
  cdu: ['heat_duty_kw', 'approach_k', 'tcs_supply_c', 'tcs_return_c'],
  pump: ['speed_pct', 'head_kpa', 'flow_kg_s', 'vibration_mm_s'],
  valve: ['opening_pct', 'flow_kg_s'],
  strainer: ['strainer_dp_kpa', 'flow_kg_s'],
  sensor: ['flow_kg_s'],
  chiller: ['fws_in_c', 'fws_out_c'],
  pipe: ['flow_kg_s', 'dp_kpa', 'velocity_m_s'],
};
const tone = (s: AssetStatus | undefined) => (s === 'isolated' ? 'isolated' : s === 'service' ? 'service' : s === 'offline' ? 'isolated' : s ?? 'nominal');

function Readings({ type, id }: { type: string; id: string }) {
  const state = useWorld((s) => s.assets[id]);
  const keys = (KEYS[type] ?? Object.keys(state?.readings ?? {})).filter((k) => state?.readings[k] !== undefined).slice(0, 4);
  if (!keys.length) return <p className="dd__empty">No live readings for this item.</p>;
  return (
    <dl className="ad__kv">
      {keys.map((k) => {
        const f = formatReading(k, state!.readings[k]);
        return (
          <div key={k}>
            <dt>{f.label}</dt>
            <dd className="num">{f.text} <small>{f.unit}</small></dd>
          </div>
        );
      })}
    </dl>
  );
}

function RobotBody({ id }: { id: string }) {
  const r = useWorld((s) => s.robots[id]);
  const m = useWorld((s) => (r?.mission_id ? s.missions[r.mission_id] : undefined));
  if (!r) return null;
  const open = () => {
    useView.getState().select(r.id);
    useMapCamera.getState().selectRobot(r.id, r.class);
    useUi.getState().setTab('map');
  };
  return (
    <>
      <div className="ad__chips">
        <Chip tone={r.class === 'inpipe' ? 'inpipe' : 'outrig'} sm>{r.class === 'inpipe' ? 'Crawler (in-pipe)' : 'Maintainer (exterior)'}</Chip>
        <Chip sm>{ROBOT_MODE_LABEL[r.mode]}</Chip>
      </div>
      <dl className="ad__kv">
        <div><dt>Battery</dt><dd className="num">{Math.round(r.battery_pct)} <small>%</small></dd></div>
        <div><dt>Mission</dt><dd>{m ? m.title : 'No mission assigned'}</dd></div>
        {m && <div><dt>Progress</dt><dd className="num">{Math.round(m.progress * 100)} <small>%</small></dd></div>}
      </dl>
      <Meter value={r.battery_pct / 100} tone={r.battery_pct < 25 ? 'warning' : 'nominal'} />
      <div className="ad__actions">
        <button className="btn btn--sm btn--primary" onClick={open}>Open in Map</button>
      </div>
      <p className="ad__note">Driving is available only in the Map tab.</p>
    </>
  );
}

/** Slim details for whatever was clicked in the scene. Read-only; deeper work happens in Map. */
export function AssetDrawer() {
  const id = useView((s) => s.selectedId);
  const robot = useWorld((s) => (id ? s.robots[id] : undefined));
  const asset = useWorld((s) => (id ? s.assetsById[id] : undefined));
  const edge = useWorld((s) => (id ? s.edgesById[id] : undefined));
  const status = useWorld((s) => (id ? s.assets[id]?.status : undefined));
  const ctxCabinet = useWorld((s) => (id ? ((s.topology as any)?.context_cabinets?.find((c: any) => c.id === id)) : undefined));
  const virt = !!id && (id.startsWith('road:') || id.startsWith('row:'));
  if (!id || (!robot && !asset && !edge && !ctxCabinet && !virt)) return null;
  const label = virt ? id.replace(/^(road|row):/, '').split(':').pop()!.toUpperCase() : robot ? labelOfId(robot.id) : ctxCabinet ? ctxCabinet.id.toUpperCase() : edge?.label ?? asset?.label ?? id;
  const sub = virt ? (id.startsWith('road:') ? 'Robot road' : 'Rack row') : robot ? robot.name : ctxCabinet ? `Row ${ctxCabinet.row_id ?? 'A1'} · Slot ${ctxCabinet.slot ?? 1}` : edge?.name ?? asset?.name ?? '';
  const type = edge ? 'pipe' : asset?.type ?? '';
  const inspect = () => {
    useView.getState().select(id);
    useUi.getState().setTab('map');
  };
  return (
    <aside className="ad panel" aria-label={`Details for ${label}`} data-inset="left">
      <header>
        <div>
          <h2 className="mono">{label}</h2>
          <p className="dd__muted">{sub}</p>
        </div>
        <button className="icon-btn" onClick={() => useView.getState().select(null)} aria-label="Close details">
          <X size={15} />
        </button>
      </header>
      {robot ? (
        <RobotBody id={id} />
      ) : ctxCabinet ? (
        <>
          <div className="ad__chips">
            <Chip tone="isolated" sm>Architectural Context</Chip>
            <Chip sm>{String(ctxCabinet.hall_id ?? 'HALL').toUpperCase()}</Chip>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 10, lineHeight: 1.5 }}>
            <p><strong>Position:</strong> [{ctxCabinet.position_xyz_m.map((v: number) => v.toFixed(1)).join(', ')}]</p>
            <p style={{ marginTop: 6, color: 'var(--t3)' }}>
              Standard 42U air-cooled server rack instance for architectural facility scale. Not instrumented with liquid-cooling sensors.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="ad__chips">
            <Chip tone={tone(status)} sm>{STATUS_LABEL[status ?? 'nominal']}</Chip>
            {edge && <Chip sm>{edge.loop.toUpperCase()} {edge.role}</Chip>}
          </div>
          {!virt && <Readings type={type} id={id} />}
          <EntityIds id={id} />
          <div className="ad__actions">
            <FlyButton id={id} />
            {!virt && <button className="btn btn--sm btn--primary" onClick={inspect}>Inspect in Map</button>}
          </div>
        </>
      )}
    </aside>
  );

}
