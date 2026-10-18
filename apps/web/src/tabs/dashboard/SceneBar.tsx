import { EyeOff, Maximize2 } from 'lucide-react';
import { C, PRESSURE_MAX_KPA, SCENE_FILTERS, marginColor, pressureColor, useDashView, useView, type SceneFilter } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { Segmented } from '../../ui/kit';
import { PresetBar } from '../../ui/PresetBar';
import { applyPreset } from '../../ui/presets';
import { IconButton } from '../../ui/kit/index';

const FILTER_LABEL: Record<SceneFilter, string> = { overview: 'Overview', loops: 'Cooling loops', robots: 'Robots', thermal: 'Thermal', pressure: 'Pressure' };

const sw = (color: string, label: string) => (
  <span className="sb__sw" key={label}>
    <i style={{ background: color }} />
    {label}
  </span>
);

function ramp(stops: Array<[number, string]>) {
  return `linear-gradient(90deg, ${stops.map(([p, c]) => `${c} ${p}%`).join(', ')})`;
}

/** What the colours mean in the current scene filter, with units. */
function Legend({ filter }: { filter: SceneFilter }) {
  const lim = useWorld((s) => s.topology?.limits);
  const warn = lim?.margin_warn_k ?? 11;
  const crit = lim?.margin_crit_k ?? 5;
  if (filter === 'thermal') {
    const hi = warn + 8;
    const stops: Array<[number, string]> = [0, 25, 50, 75, 100].map((p) => [p, marginColor(crit + ((hi - crit) * p) / 100, warn, crit)]);
    return (
      <div className="sb__legend" role="group" aria-label="Thermal legend">
        <span>GPU thermal margin (K)</span>
        <span className="num">≤ {crit}</span>
        <i className="sb__ramp" style={{ background: ramp(stops) }} />
        <span className="num">≥ {hi}</span>
        <span className="sb__note">Rack faces tint by margin; heat plumes appear below {warn} K.</span>
      </div>
    );
  }
  if (filter === 'pressure') {
    const stops: Array<[number, string]> = [0, 25, 50, 75, 100].map((p) => [p, pressureColor((PRESSURE_MAX_KPA * p) / 100)]);
    return (
      <div className="sb__legend" role="group" aria-label="Pressure legend">
        <span>Pressure drop per segment (kPa)</span>
        <span className="num">0</span>
        <i className="sb__ramp" style={{ background: ramp(stops) }} />
        <span className="num">≥ {PRESSURE_MAX_KPA}</span>
        <span className="sb__note">Measured ΔP, not absolute pressure.</span>
      </div>
    );
  }
  if (filter === 'robots') {
    return (
      <div className="sb__legend" role="group" aria-label="Robots legend">
        {sw(C.inpipe, 'Crawler (in-pipe)')}
        {sw(C.outrig, 'Maintainer (exterior)')}
        {sw('#e8b93b', 'Service lane and dock apron')}
        <span className="sb__note">Plant and racks are dimmed.</span>
      </div>
    );
  }
  return (
    <div className="sb__legend" role="group" aria-label="Pipe legend">
      {sw(C.tcsSupply, 'TCS supply')}
      {sw(C.tcsReturn, 'TCS return')}
      {sw(C.fwsSupply, 'FWS supply')}
      {sw(C.fwsReturn, 'FWS return')}
      <span className="sb__note">{filter === 'loops' ? 'Tracer speed follows measured velocity (m/s).' : 'Rack LEDs follow load; face tint follows thermal margin.'}</span>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button className="sb__tog" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

/** Bottom bar: view-only scene filters and structure toggles. Nothing here sends a command. */
export function SceneBar({ onFit, onHide }: { onFit: () => void; onHide: () => void }) {
  const filter = useDashView((s) => s.filter);
  const setFilter = useDashView((s) => s.setFilter);
  const st = useDashView((s) => s.structure);
  const setStructure = useDashView((s) => s.setStructure);
  const layers = useView((s) => s.layers);
  const setLayer = useView((s) => s.setLayer);
  const pipesOn = layers.technology_cooling && layers.facility_water;
  return (
    <div className="sb" data-inset="bottom">
      <Legend filter={filter} />
      <div className="sb__bar panel">
        <PresetBar compact />
        <span className="sb__rowsep" />
        <Segmented<SceneFilter> group="dash-filter" small value={filter} onChange={setFilter} items={SCENE_FILTERS.map((f) => ({ id: f, label: FILTER_LABEL[f] }))} />
        <span className="sb__sep" />
        <div className="sb__struct" role="group" aria-label="Structure">
          <Toggle on={layers.roof} onClick={() => setLayer('roof', !layers.roof)}>Roof</Toggle>
          <Toggle on={layers.walls} onClick={() => setLayer('walls', !layers.walls)}>Walls</Toggle>
          <Toggle on={pipesOn} onClick={() => (setLayer('technology_cooling', !pipesOn), setLayer('facility_water', !pipesOn))}>Pipes</Toggle>
          <Toggle on={st.hall} onClick={() => setStructure('hall', !st.hall)}>Server hall</Toggle>
          <Toggle on={st.plant} onClick={() => setStructure('plant', !st.plant)}>Cooling plant</Toggle>
        </div>
        <IconButton size="sm" onClick={() => (onFit(), applyPreset('fit'))} aria-label="Fit whole facility" icon={<Maximize2 size={15} />} />
        <IconButton size="sm" onClick={onHide} aria-label="Hide view controls" icon={<EyeOff size={15} />} />
      </div>
    </div>
  );
}
