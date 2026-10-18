import { useEffect } from 'react';
import { navActions, useControl, useNav, type NavDenialReason } from '@loopkeeper/core/control';
import { useWorld } from '@loopkeeper/core/store';
import { useMapCamera } from '@loopkeeper/scene';
import { Button } from '../../ui/kit/index';

const DENIAL_HINT: Record<NavDenialReason, string> = {
  NO_ACCESS: 'No legal path',
  TURN_RADIUS: 'Turn radius',
  EQUIPMENT_BLOCK: 'Equipment in the way',
  RESERVATION_CONFLICT: 'Reserved by another robot',
  PRESSURE_UNSAFE: 'Pressure unsafe',
  BATTERY: 'Battery',
  PIPE_CLEARANCE: 'Pipe clearance',
};

const cell = (k: string, v: string, warn = false) => (
  <span style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
    <span style={{ color: 'var(--t3)', fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{k}</span>
    <b className="mono" style={{ fontWeight: 500, color: warn ? 'var(--warning)' : 'var(--t1)' }}>{v}</b>
  </span>
);

/**
 * Destination mode for the selected robot (exterior OUTRIG and in-pipe crawler): pick a node, see the planner's preview, commit,
 * then pause / reroute / cancel. Every number and refusal is the server's; a refusal's reason code and detail are shown verbatim.
 */
export function RoutePanel() {
  const robotId = useMapCamera((s) => s.selectedRobotId);
  const robot = useWorld((s) => (robotId ? s.robots[robotId] : undefined));
  const live = useWorld((s) => s.connection === 'live' && !s.stale);
  const n = useNav();
  const ctl = useControl();
  const mine = n.robotId === robotId;
  const traffic = Object.values(n.traffic);

  // selecting another robot leaves destination mode for the old one (a route the server is following keeps going)
  useEffect(() => {
    const s = useNav.getState();
    if (s.robotId && s.robotId !== robotId && s.phase !== 'following' && s.phase !== 'paused') navActions.dismiss();
  }, [robotId]);

  if (!robot && traffic.length === 0) return null;
  const phase = mine ? n.phase : 'idle';
  const leased = ctl.robotId === robotId && ctl.inputEnabled;
  const busy = !!robot && (robot.mode === 'WORKING' || !!robot.mission_id);
  const serverRoute = robotId ? n.routes[robotId] : undefined;
  const showFollow = (phase === 'following' || phase === 'paused') || (!mine && !!serverRoute);
  const refusal = mine ? n.refusal : null;
  const plan = mine ? n.plan : null;

  return (
    <div className="hud-route panel" data-panel="route" role="region" aria-label="Route and traffic" data-phase={phase} style={{ pointerEvents: 'auto', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', justifyContent: 'center', padding: '6px 12px', margin: 0, maxWidth: 860, fontSize: 12, background: 'rgba(10,14,22,0.9)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)' }}>
      {robot && (
        <b style={{ fontSize: 12, letterSpacing: '0.04em', color: 'var(--t2)' }}>
          ROUTE · {robot.name}
        </b>
      )}

      {robot && phase === 'idle' && !showFollow && (
        <>
          <Button size="sm" variant="secondary" disabledReason={!live ? 'The live stream is not connected' : busy ? 'The robot is executing a mission: cancel it first' : undefined} onClick={() => void navActions.begin(robot.id)}>
            Send to destination
          </Button>
          {busy && <span style={{ color: 'var(--t3)' }}>robot is on a mission</span>}
          {n.arrived && n.robotId === robot.id && <span style={{ color: 'var(--ok, #22c55e)' }}>arrived</span>}
        </>
      )}

      {phase === 'selecting' && (
        <>
          <span>Click a destination: {robot?.class === 'inpipe' ? null : <><b style={{ color: '#2fd3e8' }}>service point</b>, </>}{robot?.class === 'inpipe' ? <b style={{ color: '#a78bfa' }}>pipe segment</b> : <b style={{ color: '#fbbf24' }}>road node</b>}.</span>
          <Button size="sm" variant="ghost" onClick={() => navActions.dismiss()}>Cancel</Button>
        </>
      )}

      {phase === 'planning' && <span>Planning to {n.target}…</span>}

      {phase === 'planned' && plan && (
        <>
          <b style={{ color: '#38bdf8' }}>PREVIEW · nothing reserved</b>
          {cell('to', plan.target)}
          {cell('eta', `${plan.eta_s.toFixed(0)} s`)}
          {cell('length', `${plan.length_m.toFixed(1)} m`)}
          {plan.wait_s > 0 && cell('wait', `${plan.wait_s.toFixed(0)} s`, true)}
          {plan.battery_needed_pct !== undefined && cell('battery', `${plan.battery_needed_pct.toFixed(0)} %`)}
          {cell('graph', plan.graph_revision.slice(-8))}
          {leased && <span style={{ color: 'var(--t3)' }}>commits under your lease</span>}
          <Button size="sm" variant="primary" disabledReason={!live ? 'The live stream is not connected' : undefined} onClick={() => void navActions.commit()}>Commit route</Button>
          <Button size="sm" variant="ghost" onClick={() => void navActions.begin(plan.robot_id)}>Pick another</Button>
          <Button size="sm" variant="ghost" onClick={() => navActions.dismiss()}>Discard</Button>
        </>
      )}

      {phase === 'committing' && <span>Committing… waiting for the server.</span>}

      {showFollow && (
        <>
          <b style={{ color: !live ? 'var(--t3)' : phase === 'paused' ? '#f59e0b' : '#22c55e' }}>
            {!live ? 'STALE · stream down, route not updating' : phase === 'paused' ? 'PAUSED · operator override' : 'RESERVED · following'}
          </b>
          {serverRoute?.target && cell('to', serverRoute.target)}
          {(plan?.eta_s ?? serverRoute?.eta_s) !== undefined && cell('eta', `${(plan?.eta_s ?? serverRoute?.eta_s)!.toFixed(0)} s`)}
          {serverRoute?.source && serverRoute.source !== 'operator' && cell('source', serverRoute.source)}
          {mine && (
            <>
              <Button size="sm" variant="ghost" disabled={!live || phase === 'paused'} title={leased ? 'Brake pulse: the server pauses destination mode' : 'No lease: this stops the route (cancel)'} onClick={() => void navActions.pause()}>{leased ? 'Pause' : 'Stop'}</Button>
              <Button size="sm" variant="secondary" disabled={!live} title="Re-plan from the current pose to the same destination" onClick={() => void navActions.reroute()}>Reroute</Button>
              <Button size="sm" variant="ghost" disabled={!live} onClick={() => void navActions.cancel()}>Cancel route</Button>
            </>
          )}
        </>
      )}

      {phase === 'arrived' && n.arrived && (
        <>
          <b style={{ color: '#22c55e' }}>ARRIVED</b>
          {n.arrived.eta_s !== undefined && cell('eta', `${n.arrived.eta_s.toFixed(0)} s`)}
          {n.arrived.actual_s !== undefined && cell('actual', `${n.arrived.actual_s.toFixed(0)} s`)}
          <Button size="sm" variant="ghost" onClick={() => navActions.dismiss()}>OK</Button>
        </>
      )}

      {refusal && (
        <span role="alert" style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', color: 'var(--warning)' }}>
          <b className="mono" title={DENIAL_HINT[refusal.reason as NavDenialReason] ?? ''}>{refusal.reason}</b>
          <span className="mono" style={{ color: 'var(--t1)' }}>{refusal.detail}</span>
          <Button size="sm" variant="ghost" onClick={() => (robot ? void navActions.begin(robot.id) : navActions.dismiss())}>Pick another</Button>
        </span>
      )}

      {n.graphStale && <span style={{ color: 'var(--warning)' }}>The navigation graph changed: plans must be re-made.</span>}

      {traffic.map((t) => (
        <span key={t.robot_id} className="mono" title={t.detail} style={{ color: t.kind === 'blocked' ? '#ef4444' : '#f59e0b', whiteSpace: 'nowrap' }}>
          {t.kind === 'blocked' ? 'BLOCKED' : 'YIELD'} {t.robot_id}
          {t.to ? ` → ${t.to}` : ''}
          {t.reason ? ` (${t.reason})` : ''}
        </span>
      ))}
    </div>
  );
}
