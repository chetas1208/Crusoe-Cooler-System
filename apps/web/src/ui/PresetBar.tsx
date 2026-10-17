import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { siteModel, topologyIssues, useView } from '@loopkeeper/scene';
import { PRESET_LABEL, applyPreset, usePreset, type PresetId } from './presets';

const ORDER: Array<Exclude<PresetId, 'road' | 'robot' | 'fit'>> = ['topdown', 'iso', 'cooling'];

/** Camera presets (both tabs): Top-down Planner, Isometric Overview, Cooling Cutaway, Road 1–4 Focus, Selected Robot, Fit Facility. */
export function PresetBar({ compact }: { compact?: boolean }) {
  const id = usePreset((s) => s.id);
  const road = usePreset((s) => s.road);
  const topo = useWorld((s) => s.topology);
  const roads = useMemo(() => (topo ? siteModel(topo).roads : []), [topo]);
  const issues = useMemo(() => (topo ? topologyIssues(topo) : []), [topo]);
  const sel = useView((s) => s.selectedId);
  const robotSelected = useWorld((s) => !!sel && !!s.robots[sel]);
  const b = (p: Exclude<PresetId, 'road'>, label?: string) => (
    <button key={p} className="btn btn--sm" data-on={id === p} aria-pressed={id === p} title={PRESET_LABEL[p].hint} style={{ whiteSpace: 'nowrap' }} disabled={p === 'robot' && !robotSelected} onClick={() => applyPreset(p)}>
      {label ?? PRESET_LABEL[p].label}
    </button>
  );
  return (
    <div className="presetbar" role="group" aria-label="Camera presets" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
      {ORDER.map((p) => b(p, compact ? PRESET_LABEL[p].label.replace(' planner', '').replace(' overview', '') : undefined))}
      {roads.length > 0 && (
        <span role="group" aria-label="Road focus" style={{ display: 'inline-flex', gap: 2, alignItems: 'center', padding: '0 2px', borderLeft: '1px solid rgba(255,255,255,0.1)', borderRight: '1px solid rgba(255,255,255,0.1)' }}>
          <span style={{ fontSize: 10, color: 'var(--t3)', padding: '0 4px' }}>Road</span>
          {roads.map((r, i) => {
            const rid = r.roadId ?? r.id;
            const on = id === 'road' && road === rid;
            return (
              <button key={rid} className="btn btn--sm" title={`${rid} focus · ${(r.meta?.clear_width_m ?? r.width).toFixed(1)} m clear · between ${r.meta?.between_rows?.join(' / ') ?? 'rows'}`} aria-pressed={on} data-on={on} style={{ minWidth: 26 }} onClick={() => applyPreset('road', rid)}>
                {i + 1}
              </button>
            );
          })}
        </span>
      )}
      {b('robot')}
      {b('fit')}
      {id === 'cooling' && issues.length > 0 && (
        <span className="mono" title={issues.slice(0, 6).map((i) => `${i.edge_id}: ${i.kind} ${i.detail}`).join('\n')} style={{ fontSize: 10.5, color: 'var(--warning)', padding: '0 6px' }}>
          topology: {issues.length} issue{issues.length > 1 ? 's' : ''} (edges drawn as delivered)
        </span>
      )}
    </div>
  );
}
