import { EntityIds, FlyButton } from '../../ui/EntityIds';
import { whereOnFloor } from '../../lib/where';
import { useMemo } from 'react';
import { useWorld, usePreviewDrive } from '@loopkeeper/core/store';
import { labelOfId } from '@loopkeeper/core';
import { controlActions, useControl } from '@loopkeeper/core/control';
import { useMapCamera, useView } from '@loopkeeper/scene';
import {
  Activity,
  AlertTriangle,
  Compass,
  Flashlight,
  Gauge,
  Lightbulb,
  Radio,
  Scan,
  ShieldAlert,
  Sliders,
  Wrench,
  XCircle,
} from 'lucide-react';

interface RobotInspectorProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

/** No robot selected: show whatever IS selected in the scene (pipe, rack, row, road, equipment) with its real ids. */
function EntityPanel() {
  const id = useView((s) => s.selectedId);
  const topo = useWorld((s) => s.topology);
  const known = useWorld((s) => !!id && (id.startsWith('road:') || id.startsWith('row:') || !!s.assetsById[id] || !!s.edgesById[id]));
  if (!id || !topo || !known) return <span>Select a robot, rack, row, road or pipe.</span>;
  const title = id.startsWith('road:') ? 'Road' : id.startsWith('row:') ? 'Rack row' : useWorld.getState().edgesById[id] ? 'Pipe segment' : 'Equipment';
  return (
    <div style={{ alignSelf: 'stretch', textAlign: 'left', color: 'var(--t1)', overflowY: 'auto' }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>{title}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{id.replace(/^(road|row):/, '').split(':').pop()}</div>
      <EntityIds id={id} />
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <FlyButton id={id} />
        <button className="btn btn--sm btn--ghost" onClick={() => useView.getState().select(null)}>Clear</button>
      </div>
    </div>
  );
}

export function RobotInspector({ collapsed, onToggleCollapse }: RobotInspectorProps) {
  const selectedRobotId = useMapCamera((s) => s.selectedRobotId);
  const robotClass = useMapCamera((s) => s.robotClass);
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const edges = useWorld((s) => s.edgesById);
  const assets = useWorld((s) => s.assets);
  const runId = useWorld((s) => s.version);
  const ctl = useControl();

  const robot = selectedRobotId ? robots[selectedRobotId] : undefined;
  const isHeld = ctl.robotId === selectedRobotId && (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED');
  const isRequesting = ctl.robotId === selectedRobotId && ctl.state === 'LEASE_REQUESTED';
  const isSafeHold = ctl.state === 'SAFE_HOLD' || robot?.mode === 'SAFE_HOLD';

  const previewActive = usePreviewDrive((s) => s.active);
  const previewRobotId = usePreviewDrive((s) => s.robotId);
  const isPreviewForMe = previewActive && previewRobotId === selectedRobotId;

  // Compute status badge
  const statusBadge = useMemo(() => {
    if (isPreviewForMe) return { label: 'PREVIEW DRIVE (GHOST)', tone: 'info' as const };
    if (isRequesting) return { label: 'REQUESTING CONTROL', tone: 'warning' as const };
    if (isHeld) return { label: 'MANUAL CONTROL', tone: 'nominal' as const };
    if (isSafeHold) return { label: 'SAFE HOLD', tone: 'danger' as const };
    if (!ctl.linkOk) return { label: 'RECONNECTING', tone: 'warning' as const };
    return { label: 'VIEWING AUTO ROBOT', tone: 'neutral' as const };
  }, [isPreviewForMe, isRequesting, isHeld, isSafeHold, ctl.linkOk]);

  if (collapsed) {
    return (
      <div
        className="map-inspector-collapsed panel"
        data-panel="inspector"
        data-inset="right"
        style={{
          width: 44,
          padding: '10px 4px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          background: 'rgba(10, 14, 22, 0.82)',
          backdropFilter: 'blur(12px)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
          cursor: 'pointer',
        }}
        onClick={onToggleCollapse}
        title="Expand Robot Inspector"
      >
        <Sliders size={18} style={{ color: 'var(--c-cyan, #2fd3e8)' }} />
        <span
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            fontSize: '11px',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--t2)',
          }}
        >
          Robot Telemetry & Tools
        </span>
      </div>
    );
  }

  if (!robot) {
    return (
      <aside
        className="map-inspector panel"
        data-panel="inspector"
        data-inset="right"
        style={{
          width: 320,
          padding: '16px',
          background: 'rgba(10, 14, 22, 0.88)',
          backdropFilter: 'blur(14px)',
          borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t3)',
        }}
      >
        <EntityPanel />
      </aside>
    );
  }

  const mission = robot.mission_id ? missions[robot.mission_id] : undefined;
  const currentEdge = robot.pose.segment_id ? edges[robot.pose.segment_id] : undefined;
  const edgeState = currentEdge ? assets[currentEdge.id] : undefined;
  const fault = edgeState?.fault;
  const readings = edgeState?.readings ?? {};

  // For pipe: bore estimation
  const s_m = robot.pose.s_m ?? 0;
  const occ = fault?.occlusion ?? 0;
  const loc = fault?.location_s_m ?? -99;
  const dep = occ * Math.exp(-(((s_m + 0.2 - loc) / 0.42) ** 2));
  const bore = (currentEdge?.diameter_mm ?? 100) * (1 - Math.min(dep, 0.9));

  // Cardinal direction for outrig
  const yawDeg = Math.round(((robot.pose.yaw_rad ?? 0) * 180) / Math.PI) % 360;
  const normalizedYaw = (yawDeg + 360) % 360;
  const where = whereOnFloor(useWorld.getState().topology, robot.pose.position_xyz_m);
  const compassDir =
    normalizedYaw >= 315 || normalizedYaw < 45
      ? 'North (+Z)'
      : normalizedYaw >= 45 && normalizedYaw < 135
      ? 'East (+X)'
      : normalizedYaw >= 135 && normalizedYaw < 225
      ? 'South (-Z)'
      : 'West (-X)';

  return (
    <aside
      className="map-inspector panel"
      data-panel="inspector"
      data-inset="right"
      style={{
        width: 320,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        background: 'rgba(10, 14, 22, 0.88)',
        backdropFilter: 'blur(14px)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.08)',
        overflowY: 'auto',
        maxHeight: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>
            Run #{runId} · {robot.class.toUpperCase()}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginTop: 2 }}>{robot.name}</div>
        </div>
        {onToggleCollapse && (
          <button
            className="btn btn--ghost"
            style={{ padding: '2px 6px', fontSize: 11 }}
            onClick={onToggleCollapse}
            title="Collapse inspector"
          >
            Hide
          </button>
        )}
      </div>

      {/* Control Authority & Lease Status Pill */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '8px 10px',
          borderRadius: 6,
          background:
            statusBadge.tone === 'nominal'
              ? 'rgba(34, 197, 94, 0.12)'
              : statusBadge.tone === 'warning'
              ? 'rgba(234, 179, 8, 0.12)'
              : statusBadge.tone === 'danger'
              ? 'rgba(239, 68, 68, 0.14)'
              : 'rgba(255, 255, 255, 0.04)',
          border:
            statusBadge.tone === 'nominal'
              ? '1px solid rgba(34, 197, 94, 0.35)'
              : statusBadge.tone === 'warning'
              ? '1px solid rgba(234, 179, 8, 0.35)'
              : statusBadge.tone === 'danger'
              ? '1px solid rgba(239, 68, 68, 0.4)'
              : '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color:
                statusBadge.tone === 'nominal'
                  ? '#4ade80'
                  : statusBadge.tone === 'warning'
                  ? '#facc15'
                  : statusBadge.tone === 'danger'
                  ? '#f87171'
                  : 'var(--t2)',
            }}
          >
            {statusBadge.label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--t3)' }}>
            {isHeld ? `Lease #${ctl.epoch}` : `Mode: ${robot.mode}`}
          </span>
        </div>

        {/* Lease metrics if held */}
        {isHeld && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11, marginTop: 4 }}>
            <div>
              <span style={{ color: 'var(--t3)' }}>RTT Latency: </span>
              <b style={{ color: '#fff' }}>{ctl.rttMs ? `${Math.round(ctl.rttMs)} ms` : '< 5 ms'}</b>
            </div>
            <div>
              <span style={{ color: 'var(--t3)' }}>Sent / Dropped: </span>
              <b style={{ color: '#fff' }}>{`${ctl.sent} / ${ctl.refused}`}</b>
            </div>
          </div>
        )}

        {/* Operator Control Actions: Non-destructive Ghost Preview vs Authoritative Live Lease */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          {/* Non-destructive Ghost Preview Drive */}
          <button
            className={`btn ${isPreviewForMe ? 'btn--primary' : 'btn--secondary'}`}
            style={{
              padding: '6px 8px',
              fontSize: 11,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 6,
              borderColor: isPreviewForMe ? '#00e5ff' : 'rgba(0, 229, 255, 0.4)',
              color: isPreviewForMe ? '#000' : '#38bdf8',
              background: isPreviewForMe ? '#00e5ff' : 'rgba(0, 229, 255, 0.08)',
            }}
            onClick={() => {
              if (isPreviewForMe) {
                usePreviewDrive.getState().exitPreview();
              } else {
                usePreviewDrive.getState().startPreview(robot.id, robot.class as 'outrig' | 'inpipe', {
                  position_xyz_m: [...robot.pose.position_xyz_m],
                  yaw_rad: robot.pose.yaw_rad,
                  segment_id: robot.pose.segment_id,
                  s_m: robot.pose.s_m,
                  speed_m_s: 0,
                });
              }
            }}
            title="Drive a temporary ghost proxy robot with Arrow Keys/WASD. Leaves backend robot unchanged."
          >
            <Compass size={13} />
            {isPreviewForMe ? 'Exit Ghost Preview (Esc)' : 'Preview Drive (Ghost · Arrow Keys)'}
          </button>

          {/* Authoritative Live Control / Takeover */}
          <div style={{ display: 'flex', gap: 6 }}>
            {isHeld ? (
              <>
                <button
                  className="btn btn--danger"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 11, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4 }}
                  onClick={() => controlActions.release('operator_release')}
                >
                  <ShieldAlert size={12} />
                  Release Lease
                </button>
                <button
                  className="btn btn--danger"
                  style={{ padding: '4px 8px', fontSize: 11 }}
                  title="Immediate Emergency Brake & Stop"
                  onClick={() => controlActions.safeStop('operator_stop')}
                >
                  <XCircle size={12} />
                  Stop
                </button>
              </>
            ) : isSafeHold ? (
              <button
                className="btn btn--secondary"
                style={{ flex: 1, padding: '4px 8px', fontSize: 11 }}
                onClick={() => controlActions.dismiss()}
              >
                Acknowledge & Resume
              </button>
            ) : (
              <button
                className="btn btn--primary"
                disabled={isRequesting || robot.battery_pct <= 8 || robot.mode === 'WORKING' || isPreviewForMe}
                style={{ flex: 1, padding: '5px 8px', fontSize: 11, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
                onClick={() => void controlActions.takeControl(robot.id)}
                title="Acquire real server lease and control the physical backend robot."
              >
                <Gauge size={13} />
                {isRequesting ? 'Acquiring Lease…' : 'Take LIVE Control'}
              </button>
            )}
          </div>
        </div>
        {!isRequesting && ctl.state === 'AUTONOMOUS' && (robot.battery_pct <= 8 || robot.mode === 'WORKING') && (
          <div data-testid="control-disabled-reason" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.35, color: '#ffd9a0' }}>
            {robot.mode === 'WORKING'
              ? `${robot.id} is mid-repair: the server refuses manual control until the job finishes (it would interrupt a physical service action).`
              : `${robot.id} battery is ${Math.round(robot.battery_pct)} %: manual control needs more than 8 %.`}
          </div>
        )}
        {ctl.notice && (
          <div
            role="status"
            data-testid="control-notice"
            style={{ marginTop: 6, padding: '5px 8px', borderRadius: 5, fontSize: 11, lineHeight: 1.35,
              color: ctl.notice.tone === 'error' ? '#ffb4b4' : ctl.notice.tone === 'warn' ? '#ffd9a0' : '#bfe9f0',
              background: ctl.notice.tone === 'error' ? 'rgba(220,60,60,0.14)' : ctl.notice.tone === 'warn' ? 'rgba(245,158,11,0.13)' : 'rgba(47,211,232,0.1)',
              border: '1px solid rgba(255,255,255,0.08)' }}
          >
            {ctl.notice.text}
          </div>
        )}
      </div>

      {/* Telemetry Panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          Authoritative Telemetry
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            background: 'rgba(255, 255, 255, 0.02)',
            padding: 8,
            borderRadius: 6,
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {robotClass === 'inpipe' ? (
            <>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Segment</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#2fd3e8' }}>
                  {robot.pose.segment_id ? currentEdge?.label ?? robot.pose.segment_id : 'Dock'}
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Longitudinal s</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{s_m.toFixed(2)} m</div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Bore Ahead</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: dep > 0.15 ? '#f59e0b' : '#fff' }}>
                  {bore.toFixed(0)} mm
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Velocity</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                  {(robot.pose.speed_m_s ?? 0).toFixed(2)} m/s
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Flow Speed</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                  {(readings.velocity_m_s ?? 0).toFixed(2)} m/s
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Segment ΔP</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                  {(readings.dp_kpa ?? 0).toFixed(1)} kPa
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Global X / Z</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#ff9a3c' }}>
                  {`${robot.pose.position_xyz_m[0].toFixed(2)} m, ${robot.pose.position_xyz_m[2].toFixed(2)} m`}
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Heading</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                  {`${normalizedYaw}° (${compassDir})`}
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Floor Speed</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                  {(robot.pose.speed_m_s ?? 0).toFixed(2)} m/s
                </div>
              </div>
              <div className="tele-item">
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Battery</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>
                  {Math.round(robot.battery_pct)}%
                </div>
              </div>
              <div className="tele-item" style={{ gridColumn: 'span 2' }}>
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>Road / zone</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--t2)' }} className="mono">
                  {where}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Tools & Actuators Section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          Tool Actuators
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Work Light / Lamp */}
          <button
            className="btn btn--secondary"
            disabled={!isHeld}
            style={{
              padding: '6px 10px',
              fontSize: 11,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
            onClick={() => {
              const curLamp = robot.control?.lamp ?? false;
              controlActions.tool(curLamp ? 'lamp_off' : 'lamp_on');
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lightbulb size={13} style={{ color: robot.control?.lamp ? '#facc15' : 'var(--t3)' }} />
              {robotClass === 'inpipe' ? 'Inspection Lamp' : 'Work Floodlight'}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: robot.control?.lamp ? '#4ade80' : 'var(--t3)' }}>
              {robot.control?.lamp ? 'ACTIVE' : 'OFF'}
            </span>
          </button>

          {/* Inspection / Sensor Scan */}
          <button
            className="btn btn--secondary"
            disabled={!isHeld}
            style={{
              padding: '6px 10px',
              fontSize: 11,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
            onClick={() => controlActions.tool('scan')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Scan size={13} style={{ color: 'var(--c-cyan, #2fd3e8)' }} />
              {robotClass === 'inpipe' ? 'Ultrasonic Wall Bore Scan' : 'Thermal & Visual IR Scan'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--t3)' }}>Key [E]</span>
          </button>

          {/* Service / Maintenance Action */}
          <div
            style={{
              fontSize: 10,
              color: 'var(--t3)',
              padding: '4px 6px',
              borderRadius: 4,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}
          >
            {robotClass === 'inpipe'
              ? 'Deposit scraper & clearing brush available on deposit contact.'
              : 'Service manipulator arms for strainers, valves, and flange clamps.'}
          </div>
        </div>
      </div>

      {/* Active Mission Checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          {mission ? `Mission · ${mission.id}` : 'Autonomous Mission'}
        </div>
        {mission ? (
          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: 8, borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 650, color: '#fff', marginBottom: 6 }}>{mission.title}</div>
            <ol style={{ paddingLeft: 16, margin: 0, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {mission.steps.map((st) => (
                <li
                  key={st.id}
                  style={{
                    color:
                      st.status === 'done'
                        ? '#4ade80'
                        : st.status === 'active'
                        ? '#2fd3e8'
                        : 'var(--t3)',
                  }}
                >
                  <span>{st.label}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--t3)' }}>No mission assigned. Robot is available.</div>
        )}
      </div>
    </aside>
  );
}
