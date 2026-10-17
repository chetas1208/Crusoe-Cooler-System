import { samplePose, useWorld } from '@loopkeeper/core/store';
import { CAUSE_LABEL, STATUS_LABEL, labelOfId } from '@loopkeeper/core';
import { READING_META, type Incident, type Vec3 } from '@loopkeeper/core/contracts';
import { entityFocus, useView } from '@loopkeeper/scene';
import { AnchoredLabel } from './anchors';
import { useUi } from './store';

const KEY: Record<string, string> = { rack: 'margin_k', pump: 'vibration_mm_s', valve: 'opening_pct', strainer: 'strainer_dp_kpa', sensor: 'flow_kg_s', cdu: 'approach_k', pipe: 'flow_kg_s' };

function IncidentCallout({ inc, yOffset = 0, expanded }: { inc: Incident; yOffset?: number; expanded: boolean }) {
  const asset = useWorld((s) => s.assets[inc.anchor.entity_id]);
  const edge = useWorld((s) => s.edgesById[inc.anchor.entity_id]);
  const pin = useUi((s) => s.pin);
  const tone = inc.status === 'escalated' ? 'critical' : inc.severity;
  const line =
    edge && asset
      ? `ΔP ${asset.readings.dp_kpa?.toFixed(1)} kPa · ${asset.readings.flow_kg_s?.toFixed(2)} kg/s`
      : asset?.readings.margin_k !== undefined
        ? `margin ${asset.readings.margin_k.toFixed(1)} K`
        : CAUSE_LABEL[inc.cause];
  const p = inc.anchor.position_xyz_m;
  return (
    <AnchoredLabel get={() => [p[0], p[1] + 0.3 + yOffset, p[2]]} priority={expanded ? 15 : 10}>
      <button className="callout" data-tone={tone} data-compact={!expanded} onClick={() => (pin(inc.id), useView.getState().focusIncident(inc.id))}>
        <span className="callout__top">
          <i className="callout__dot" />
          <b className="mono">{inc.id}</b>
          <span>{inc.status === 'escalated' ? 'Needs operator' : inc.severity === 'critical' ? 'Critical' : inc.severity === 'warning' ? 'Warning' : 'Anomaly'}</span>
        </span>
        <span className="callout__title">{inc.title}</span>
        <span className="callout__line num">{line}</span>
        <span className="callout__stem" />
      </button>
    </AnchoredLabel>
  );
}

const ROBOT = (m: string) => m.toLowerCase().replace('_', ' ');

function Tag({ id }: { id: string }) {
  const robot = useWorld((s) => s.robots[id]);
  const edge = useWorld((s) => s.edgesById[id]);
  const asset = useWorld((s) => s.assetsById[id]);
  const state = useWorld((s) => s.assets[id]);
  const selected = useView((s) => s.selectedId === id);
  const label = robot ? labelOfId(robot.id) : edge?.label ?? asset?.label ?? id;
  const type = robot ? (robot.class === 'inpipe' ? 'crawler' : 'maintainer') : edge ? 'pipe' : asset?.type ?? '';
  const mk = robot ? undefined : KEY[edge ? 'pipe' : asset?.type ?? ''];
  const val = mk && state?.readings[mk] !== undefined ? `${state.readings[mk].toFixed(READING_META[mk]?.decimals ?? 1)} ${READING_META[mk]?.unit}` : null;
  const lift = robot ? (robot.class === 'inpipe' ? 0.9 : 2.6) : asset?.type === 'rack' ? 1.7 : asset?.type === 'cdu' ? 1.5 : 0.7;
  const get = (): Vec3 | null => {
    if (robot) {
      const sp = samplePose(id);
      return sp ? [sp.pos[0], sp.pos[1] + lift, sp.pos[2]] : null;
    }
    const f = entityFocus(id);
    return f ? [f.target[0], f.target[1] + lift, f.target[2]] : null;
  };
  return (
    <AnchoredLabel get={get} priority={20}>
      <span className="tag" data-selected={selected} data-tone={state?.status ?? 'nominal'}>
        <b>{label}</b>
        <em>{robot ? ROBOT(robot.mode) : type}</em>
        {val && <span className="num">{val}</span>}
        {state && state.status !== 'nominal' && <span className={`tag__s tone-${state.status === 'isolated' ? 'isolated' : state.status}`}>{STATUS_LABEL[state.status]}</span>}
      </span>
    </AnchoredLabel>
  );
}

const SEV_RANK = { critical: 3, warning: 2, watch: 1, nominal: 0 } as const;

/** DOM overlay of anchored labels (incident callouts + hover/selection/follow tags). */
export function LabelLayer() {
  const labels = useView((s) => s.layers.labels);
  const mode = useView((s) => s.mode);
  const hover = useView((s) => s.hoverId);
  const selected = useView((s) => s.selectedId);
  const follow = useView((s) => s.followRobotId);
  const focused = useView((s) => s.focusedIncidentId);
  const incidents = useWorld((s) => s.incidents);
  if (!labels || mode === 'pipe') return null;

  // Filter and prioritize incidents: display at most 1-2 active alerts (highest priority or focused)
  const open = Object.values(incidents).filter((i) => !i.closed_tick);
  const sorted = [...open].sort((a, b) => {
    if (a.id === focused) return -1;
    if (b.id === focused) return 1;
    const sDiff = (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0);
    if (sDiff !== 0) return sDiff;
    return b.opened_at_s - a.opened_at_s;
  });
  // Cap at 2 active callouts to avoid 3D label clutter
  const visibleIncidents = sorted.slice(0, 2);

  const anchorIds = new Set(visibleIncidents.map((i) => i.anchor.entity_id));
  const tags = new Set<string>();
  if (hover) tags.add(hover);
  if (selected) tags.add(selected);
  if (follow) tags.add(follow);

  // Check if the 2 visible callouts are close to each other in 3D space to apply anti-collision offset
  const collision =
    visibleIncidents.length === 2 &&
    Math.hypot(
      visibleIncidents[0].anchor.position_xyz_m[0] - visibleIncidents[1].anchor.position_xyz_m[0],
      visibleIncidents[0].anchor.position_xyz_m[2] - visibleIncidents[1].anchor.position_xyz_m[2],
    ) < 3.2;

  return (
    <div className="labels" aria-hidden={false}>
      {visibleIncidents.map((i, idx) => (
        <IncidentCallout key={i.id} inc={i} yOffset={idx === 1 && collision ? 0.85 : 0} expanded={i.anchor.entity_id === hover || i.anchor.entity_id === selected} />
      ))}
      {[...tags]
        .filter((t) => !anchorIds.has(t) || t === follow)
        .map((t) => (
          <Tag key={t} id={t} />
        ))}
    </div>
  );
}
