import { useControl, useNav } from '@loopkeeper/core/control';
import { nearestEdge } from './roadOf';
import { useWorld } from '@loopkeeper/core/store';

/**
 * What the operator needs to trust a manual session: who holds the lease, whether the link is up, how long a command takes
 * to be acknowledged, what the server last applied (or refused), where the robot actually is, and why a session ended.
 * Every number is measured by the control session or read from the authoritative robot; nothing is estimated here.
 */
export function DriveLinkBar({ robotId }: { robotId: string }) {
  const ctl = useControl();
  const robot = useWorld((s) => s.robots[robotId]);
  const gExt = useNav((n) => n.graphs.exterior);
  const gRev = useNav((n) => n.graphRevision);
  const route = useNav((n) => n.routes[robotId]);
  const mine = ctl.robotId === robotId;
  const active = mine && ctl.state !== 'AUTONOMOUS';
  if (!active && !(mine && ctl.stop)) return null;
  const holder = robot?.control?.holder ?? (mine ? ctl.clientId : undefined);
  const seg = robot?.nav?.segment_id ?? robot?.pose.segment_id ?? ctl.ack?.pose.segment_id;
  // exterior robots have no pipe segment: name the road / cross-aisle edge whose centreline is nearest the authoritative pose
  const road = !seg && robot ? nearestEdge(gExt, robot.pose.position_xyz_m[0], robot.pose.position_xyz_m[2]) : null;
  const cell = (k: string, v: string, warn = false) => (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--t3)', fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{k}</span>
      <b className="mono" style={{ fontWeight: 500, color: warn ? 'var(--warning)' : 'var(--t1)' }}>{v}</b>
    </span>
  );
  return (
    <div className="hud-link panel" data-panel="drive-link" role="status" aria-label="Manual control link" style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center', justifyContent: 'center', padding: '5px 12px', margin: '0 auto 8px', maxWidth: 820, fontSize: 12, background: 'rgba(10,14,22,0.9)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)' }}>
      {cell('state', ctl.state.replace(/_/g, ' '), ctl.state === 'SAFE_HOLD')}
      {cell('lease', holder ? String(holder).slice(0, 14) : '—')}
      {cell('link', ctl.linkOk ? 'ok' : 'LOST', !ctl.linkOk)}
      {cell('ack rtt', ctl.rttMs === null ? 'no ack yet' : `${Math.round(ctl.rttMs)} ms`, (ctl.rttMs ?? 0) > 250)}
      {cell('sent / refused', `${ctl.sent} / ${ctl.refused}`, ctl.refused > 0)}
      {cell(seg ? 'pipe segment' : 'road', seg ? `${seg}${ctl.ack ? ` · s ${ctl.ack.pose.s_m.toFixed(1)} m` : ''}` : road ? `${road.road ?? road.id}${road.dist > 1.5 ? ' (off centreline)' : ''}` : '—')}
      {cell('graph', gRev ? gRev.slice(-8) : '—')}
      {route && cell('route', `${route.status} ${route.target ?? route.plan_id}`, route.status === 'paused')}
      {robot?.clearance_m !== undefined && cell('clearance', `${(robot.clearance_m * 100).toFixed(0)} cm`)}
      {ctl.stop && cell('stop reason', ctl.stop.text, true)}
      {!ctl.stop && robot?.control?.last_reason && mine && cell('last stop', robot.control.last_reason.replace(/_/g, ' '))}
    </div>
  );
}
