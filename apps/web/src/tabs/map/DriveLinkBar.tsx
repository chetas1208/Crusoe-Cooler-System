import { useControl } from '@loopkeeper/core/control';
import { useWorld } from '@loopkeeper/core/store';

/**
 * What the operator needs to trust a manual session: who holds the lease, whether the link is up, how long a command takes
 * to be acknowledged, what the server last applied (or refused), where the robot actually is, and why a session ended.
 * Every number is measured by the control session or read from the authoritative robot; nothing is estimated here.
 */
export function DriveLinkBar({ robotId }: { robotId: string }) {
  const ctl = useControl();
  const robot = useWorld((s) => s.robots[robotId]);
  const mine = ctl.robotId === robotId;
  const active = mine && ctl.state !== 'AUTONOMOUS';
  if (!active && !(mine && ctl.stop)) return null;
  const holder = robot?.control?.holder ?? (mine ? ctl.clientId : undefined);
  const seg = robot?.nav?.segment_id ?? robot?.pose.segment_id ?? ctl.ack?.pose.segment_id;
  const cell = (k: string, v: string, warn = false) => (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--t3)', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{k}</span>
      <b className="mono" style={{ fontWeight: 500, color: warn ? 'var(--warning)' : 'var(--t1)' }}>{v}</b>
    </span>
  );
  return (
    <div className="hud-link panel" role="status" aria-label="Manual control link" style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center', justifyContent: 'center', padding: '5px 12px', margin: '0 auto 8px', maxWidth: 820, fontSize: 11, background: 'rgba(10,14,22,0.9)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)' }}>
      {cell('state', ctl.state.replace(/_/g, ' '), ctl.state === 'SAFE_HOLD')}
      {cell('lease', holder ? String(holder).slice(0, 14) : '—')}
      {cell('link', ctl.linkOk ? 'ok' : 'LOST', !ctl.linkOk)}
      {cell('ack rtt', ctl.rttMs === null ? 'no ack yet' : `${Math.round(ctl.rttMs)} ms`, (ctl.rttMs ?? 0) > 250)}
      {cell('sent / refused', `${ctl.sent} / ${ctl.refused}`, ctl.refused > 0)}
      {cell('segment', seg ? `${seg}${ctl.ack ? ` · s ${ctl.ack.pose.s_m.toFixed(1)} m` : ''}` : '—')}
      {robot?.clearance_m !== undefined && cell('clearance', `${(robot.clearance_m * 100).toFixed(0)} cm`)}
      {ctl.stop && cell('stopped', ctl.stop.text, true)}
    </div>
  );
}
