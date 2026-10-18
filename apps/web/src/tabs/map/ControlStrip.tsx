import { controlActions, useControl, useNav } from '@loopkeeper/core/control';
import { usePreviewDrive, useWorld } from '@loopkeeper/core/store';
import { useMapCamera } from '@loopkeeper/scene';
import { nearestEdge } from './roadOf';
import { Button } from '../../ui/kit/index';

type Owner = 'AUTO' | 'HUMAN' | 'STOP';

const OWNER_TONE: Record<Owner, { bg: string; fg: string }> = {
  AUTO: { bg: 'rgba(47,211,232,0.16)', fg: '#2fd3e8' },
  HUMAN: { bg: 'rgba(34,197,94,0.18)', fg: '#22c55e' },
  STOP: { bg: 'rgba(239,68,68,0.2)', fg: '#f87171' },
};

const cell = (k: string, v: string, tone?: string) => (
  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
    <span style={{ color: 'var(--t3)', fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{k}</span>
    <b className="mono" style={{ fontWeight: 500, color: tone ?? 'var(--t1)' }}>{v}</b>
  </span>
);

/**
 * The robot control slot of the Map stage: always visible while a robot is selected, bottom-centre, never under a drawer or the View dock.
 * Robot id, owner (AUTO / HUMAN / STOP), mode, speed, segment, battery, link and ack RTT, and the three control buttons.
 * Every value is the server's (authoritative robot record + the control session); the ghost preview is labelled as what it is.
 */
export function ControlStrip() {
  const robotId = useMapCamera((s) => s.selectedRobotId);
  const robot = useWorld((s) => (robotId ? s.robots[robotId] : undefined));
  const live = useWorld((s) => s.connection === 'live' && !s.stale);
  const gExt = useNav((n) => n.graphs.exterior);
  const ctl = useControl();
  const previewOn = usePreviewDrive((s) => s.active && s.robotId === robotId);

  if (!robot) {
    return (
      <div className="hud-control panel" data-panel="control-hud" data-stage-inset="bottom" role="region" aria-label="Robot control" style={shell}>
        <span style={{ color: 'var(--t2)', fontSize: 12 }}>No robot selected. Pick one in Fleet Selection or click it on the map.</span>
      </div>
    );
  }
  const mine = ctl.robotId === robot.id;
  const held = mine && (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED');
  const requesting = mine && ctl.state === 'LEASE_REQUESTED';
  const stopped = (mine && (ctl.state === 'SAFE_STOP' || ctl.state === 'SAFE_HOLD' || ctl.state === 'RELEASE_PENDING')) || robot.mode === 'SAFE_HOLD' || robot.control?.controller_state === 'SAFE_HOLD';
  const owner: Owner = stopped ? 'STOP' : held || robot.control?.authority === 'HUMAN' ? 'HUMAN' : 'AUTO';
  const tone = OWNER_TONE[owner];
  const seg = robot.nav?.segment_id ?? robot.pose.segment_id;
  const road = !seg ? nearestEdge(gExt, robot.pose.position_xyz_m[0], robot.pose.position_xyz_m[2]) : null;
  const speed = Math.abs(robot.pose.speed_m_s ?? 0);
  const disabledWhy = !live ? 'The live stream is not connected, so control cannot be granted.' : robot.battery_pct <= 8 ? `Battery ${Math.round(robot.battery_pct)} %: manual control needs more than 8 %.` : robot.mode === 'WORKING' ? 'Mid-repair: the server refuses manual control until the job finishes.' : previewOn ? 'Exit the ghost preview first.' : '';
  const link = held ? (ctl.linkOk ? 'ok' : 'LOST') : live ? 'stream live' : 'stream down';
  const linkBad = held ? !ctl.linkOk : !live;

  return (
    <div className="hud-control panel" data-panel="control-hud" data-stage-inset="bottom" data-owner={owner} role="region" aria-label={`Robot control: ${robot.name}`} style={shell}>
      <b style={{ fontSize: 13, letterSpacing: '0.04em' }}>{robot.id}</b>
      <span data-testid="owner-chip" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', padding: '2px 8px', borderRadius: 4, background: tone.bg, color: tone.fg }}>{owner}</span>
      {cell('mode', robot.mode)}
      {cell('speed', `${speed.toFixed(2)} m/s`)}
      {cell(seg ? 'segment' : 'road', seg ? String(seg) : road ? (road.road ?? road.id) : '—')}
      {cell('battery', `${Math.round(robot.battery_pct)} %`, robot.battery_pct <= 20 ? 'var(--warning)' : undefined)}
      {cell('link', held && ctl.rttMs !== null ? `${link} · ${Math.round(ctl.rttMs)} ms` : link, linkBad ? 'var(--warning)' : undefined)}
      {previewOn && (
        <span data-testid="preview-label" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.5)', borderRadius: 4, padding: '2px 6px' }}>
          PREVIEW ONLY · local ghost, no robot moves
        </span>
      )}
      <span style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto' }}>
        {held ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => controlActions.release('operator_release')} title="Hand the robot back to the agent (Esc)">Release</Button>
            <Button size="sm" variant="danger" onClick={() => controlActions.safeStop('operator_stop')} title="Emergency brake and stop">Stop</Button>
          </>
        ) : stopped && !requesting ? (
          <Button size="sm" variant="secondary" onClick={() => controlActions.dismiss()}>Acknowledge</Button>
        ) : (
          <Button size="sm" variant="primary" loading={requesting} disabledReason={disabledWhy || undefined} onClick={() => void controlActions.takeControl(robot.id)}>
            {requesting ? 'Acquiring…' : 'Take Control'}
          </Button>
        )}
      </span>
      {!held && disabledWhy && !requesting && <span style={{ flexBasis: '100%', color: 'var(--t3)', fontSize: 12 }}>{disabledWhy}</span>}
    </div>
  );
}

const shell: React.CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 14px',
  alignItems: 'center',
  padding: '7px 12px',
  margin: '0 auto',
  width: '100%',
  maxWidth: 860,
  boxSizing: 'border-box',
  fontSize: 12,
  background: 'rgba(10,14,22,0.92)',
  backdropFilter: 'blur(12px)',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
};
