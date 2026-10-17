import { useMemo } from 'react';
import { DriveLinkBar } from './DriveLinkBar';
import { useWorld, usePreviewDrive } from '@loopkeeper/core/store';
import { useControl, controlActions } from '@loopkeeper/core/control';
import { whereOnFloor } from '../../lib/where';
import {
  useMapCamera,
  useView,
  CAMERA_MOUNTS,
  type CameraMode,
  type MountedDirection,
  type ThirdPersonMode,
} from '@loopkeeper/scene';
import {
  Camera,
  Compass,
  Crosshair,
  Eye,
  Maximize2,
  Minimize2,
  RotateCw,
  Video,
  View,
  Gauge,
  Wrench,
  Zap,
  Sparkles,
} from 'lucide-react';

interface ControlHUDProps {
  immersive: boolean;
  onToggleImmersive: () => void;
}

export function ControlHUD({ immersive, onToggleImmersive }: ControlHUDProps) {
  const selectedRobotId = useMapCamera((s) => s.selectedRobotId);
  const robotClass = useMapCamera((s) => s.robotClass);
  const cameraMode = useMapCamera((s) => s.cameraMode);
  const firstPersonDir = useMapCamera((s) => s.firstPersonDirection);
  const thirdPersonMode = useMapCamera((s) => s.thirdPersonMode);
  const setCameraMode = useMapCamera((s) => s.setCameraMode);
  const setFirstPersonDir = useMapCamera((s) => s.setFirstPersonDirection);
  const setThirdPersonMode = useMapCamera((s) => s.setThirdPersonMode);

  const robots = useWorld((s) => s.robots);
  const edges = useWorld((s) => s.edgesById);
  const mechanicalFixtures = useWorld((s) => s.mechanical_fixtures);
  const robot = selectedRobotId ? robots[selectedRobotId] : undefined;
  const ctl = useControl();
  const noRobot = !robot;
  const reason = 'Select a robot first';

  const isDriving = ctl.robotId === selectedRobotId && (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED');

  const mountInfo = useMemo(() => {
    return CAMERA_MOUNTS[robotClass]?.[firstPersonDir];
  }, [robotClass, firstPersonDir]);

  // Contextual segment label or floor label
  const locBadge = useMemo(() => {
    if (!robot) return 'STANDBY';
    if (robot.class === 'inpipe') {
      const segId = robot.pose.segment_id;
      const edge = segId ? edges[segId] : undefined;
      return edge ? `${edge.label} (${(robot.pose.s_m ?? 0).toFixed(1)}m)` : 'PORT DOCK';
    }
    return `${whereOnFloor(useWorld.getState().topology, robot.pose.position_xyz_m).split(' · ')[0].toUpperCase()} (${robot.pose.position_xyz_m[0].toFixed(1)}, ${robot.pose.position_xyz_m[2].toFixed(1)})`;
  }, [robot, edges]);

  const dirBadge = useMemo(() => {
    if (noRobot) return 'TACTICAL OVERVIEW · SELECT A ROBOT';
    if (cameraMode === 'first_person') {
      return mountInfo?.viewportBadge ?? firstPersonDir.toUpperCase();
    }
    if (cameraMode === 'third_person') {
      return thirdPersonMode === 'chase'
        ? 'CHASE FOLLOWER'
        : thirdPersonMode === 'orbit'
        ? 'ORBIT INSPECTION'
        : 'CUTAWAY X-RAY';
    }
    return 'TACTICAL OVERVIEW';
  }, [noRobot, cameraMode, mountInfo, firstPersonDir, thirdPersonMode]);

  return (
    <div
      className="map-control-hud"
      style={{
        position: 'absolute',
        top: 64,
        left: 0,
        right: 0,
        bottom: 20,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '0 16px',
        boxSizing: 'border-box',
      }}
    >
      {/* Top Bar: Viewport Badge & Camera Mode Selector */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          margin: '0 auto',
        }}
      >
        {/* V9 Non-Destructive Ghost Preview Banner */}
        {usePreviewDrive((s) => s.active) && (
          <div
            className="hud-preview-banner panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '6px 14px',
              background: 'rgba(8, 47, 73, 0.94)',
              backdropFilter: 'blur(14px)',
              border: '1px solid #00e5ff',
              borderRadius: 6,
              boxShadow: '0 0 16px rgba(0, 229, 255, 0.35)',
              color: '#e0f2fe',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: '#00e5ff',
                color: '#000',
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              Ghost Preview Mode
            </span>
            <span style={{ fontSize: 11, color: '#bae6fd' }}>
              Steer with <b>Arrow Keys / WASD</b> · Traveled: <b>{usePreviewDrive.getState().distanceTraveledM.toFixed(1)}m</b> · Authoritative Robot Unchanged
            </span>
            <button
              className="btn btn--sm btn--ghost"
              style={{ padding: '2px 8px', fontSize: 10, borderColor: '#38bdf8', color: '#fff' }}
              onClick={() => usePreviewDrive.getState().exitPreview()}
              title="Exit preview and restore authoritative view"
            >
              Exit (Esc)
            </button>
          </div>
        )}

        {/* Viewport Badge */}
        <div
          className="hud-pill panel"
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            background: 'rgba(10, 14, 22, 0.85)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 6,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: isDriving ? '#22c55e' : '#2fd3e8',
              boxShadow: isDriving ? '0 0 8px #22c55e' : '0 0 6px #2fd3e8',
            }}
          />
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
            <span style={{ color: '#fff' }}>{robot ? robot.name : 'NO ROBOT'}</span>
            <span style={{ color: 'var(--t3)', margin: '0 6px' }}>·</span>
            <span style={{ color: 'var(--t2)' }}>{locBadge}</span>
            <span style={{ color: 'var(--t3)', margin: '0 6px' }}>·</span>
            <span style={{ color: '#2fd3e8' }}>{dirBadge}</span>
          </div>
        </div>

        {/* Camera Perspective Mode Switcher */}
        <div
          className="hud-cam-modes panel"
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: 3,
            background: 'rgba(10, 14, 22, 0.85)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 6,
          }}
        >
          <button
            className={`btn ${cameraMode === 'tactical' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setCameraMode('tactical')}
            title="Tactical Map Overview (Contextual to class)"
          >
            <View size={13} />
            Tactical
          </button>

          <button
            className={`btn ${cameraMode === 'first_person' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setCameraMode('first_person')}
            title={noRobot ? reason : 'Onboard Sensor / First-Person Robot POV'}
            disabled={noRobot}
          >
            <Camera size={13} />
            Robot POV
          </button>

          <button
            className={`btn ${cameraMode === 'third_person' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setCameraMode('third_person')}
            title={noRobot ? reason : 'Third-Person Chase / Orbit / Cutaway Follower'}
            disabled={noRobot}
          >
            <Eye size={13} />
            Third Person
          </button>

          <div style={{ width: 1, height: 16, background: 'rgba(255, 255, 255, 0.12)', margin: '0 2px' }} />

          <button
            className={`btn ${useView((s) => s.native4k) ? 'btn--primary' : 'btn--ghost'}`}
            style={{
              fontSize: 11,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: useView((s) => s.native4k) ? '#10b981' : undefined,
              borderColor: useView((s) => s.native4k) ? 'rgba(16, 185, 129, 0.5)' : undefined,
            }}
            onClick={() => useView.getState().toggle4k()}
            title={useView.getState().native4k ? '4K Native Buffer (3840×2160) Active' : 'Switch to 4K Native Resolution Mode'}
          >
            <Gauge size={13} />
            {useView((s) => s.native4k) ? '4K 2160p' : '1080p'}
          </button>

          <button
            className={`btn ${immersive ? 'btn--primary' : 'btn--ghost'}`}
            style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={onToggleImmersive}
            title={immersive ? 'Restore UI Panels' : 'Full Immersion HUD Mode (H)'}
          >
            {immersive ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      {/* Center Reticle in First-Person Mode */}
      {cameraMode === 'first_person' && !noRobot && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            opacity: 0.7,
          }}
        >
          <Crosshair size={28} style={{ color: '#2fd3e8' }} />
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: 'var(--c-cyan, #2fd3e8)',
              background: 'rgba(8, 12, 18, 0.65)',
              padding: '1px 6px',
              borderRadius: 3,
            }}
          >
            {mountInfo?.fixed ? 'FIXED SENSOR MOUNT' : 'GIMBAL ACTIVE · DRAG TO LOOK'}
          </div>
        </div>
      )}

      {/* Bottom Controls Bar: Camera Sub-View Chooser & Driving HUD */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* First-Person Mounted Viewpoints (Slots 1-5) */}
        {cameraMode === 'first_person' && !noRobot && (
          <div
            className="hud-subviews panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              background: 'rgba(10, 14, 22, 0.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 6,
            }}
          >
            {(['front', 'rear', 'left', 'right', 'top'] as MountedDirection[]).map((dir, idx) => {
              const active = firstPersonDir === dir;
              const slotNum = idx + 1;
              return (
                <button
                  key={dir}
                  className={`btn ${active ? 'btn--primary' : 'btn--ghost'}`}
                  style={{ fontSize: 11, padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setFirstPersonDir(dir)}
                >
                  <span style={{ opacity: 0.6, fontSize: 9 }}>⇧{slotNum}</span>
                  <span style={{ textTransform: 'capitalize' }}>{dir}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Third-Person Mode Selector (Chase / Orbit / Cutaway) */}
        {cameraMode === 'third_person' && !noRobot && (
          <div
            className="hud-subviews panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              background: 'rgba(10, 14, 22, 0.85)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: 6,
            }}
          >
            <button
              className={`btn ${thirdPersonMode === 'chase' ? 'btn--primary' : 'btn--ghost'}`}
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => setThirdPersonMode('chase')}
              title="Trailing collision-checked chase camera"
            >
              Chase Follower
            </button>
            <button
              className={`btn ${thirdPersonMode === 'orbit' ? 'btn--primary' : 'btn--ghost'}`}
              style={{ fontSize: 11, padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setThirdPersonMode('orbit')}
              title="Interactive 360° orbit around robot (drag canvas)"
            >
              <RotateCw size={12} />
              Orbit
            </button>
            {robotClass === 'inpipe' && (
              <button
                className={`btn ${thirdPersonMode === 'cutaway' ? 'btn--primary' : 'btn--ghost'}`}
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setThirdPersonMode('cutaway')}
                title="Cutaway X-ray follower revealing crawler inside pipe"
              >
                Cutaway X-Ray
              </button>
            )}
          </div>
        )}

        {selectedRobotId && <DriveLinkBar robotId={selectedRobotId} />}

        {/* V5 Manipulation & Mechanical Repair HUD for OUTRIG */}
        {isDriving && robotClass === 'outrig' && (
          <div
            className="hud-manipulation-bar panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '8px 14px',
              background: 'rgba(10, 14, 22, 0.92)',
              backdropFilter: 'blur(14px)',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
              margin: '0 auto 8px auto',
              maxWidth: 760,
            }}
          >
            {/* Header / State Row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: '#60a5fa' }}>
                <Wrench size={13} />
                <span>6-DOF ARTICULATED ARM & GRIPPER (MUJOCO AUTHORITATIVE)</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 10 }}>
                <span>HELD: <b style={{ color: robot?.held_object_id ? '#22c55e' : 'var(--t3)' }}>{robot?.held_object_id || 'NONE'}</b></span>
                <span>FORCE: <b style={{ color: (robot?.grip_force_N ?? 0) > 0.5 ? '#22c55e' : 'var(--t2)' }}>{(robot?.grip_force_N ?? 0).toFixed(1)} N</b></span>
                <span>APERTURE: <b style={{ color: '#2fd3e8' }}>{((robot?.gripper_aperture_m ?? 0.04) * 1000).toFixed(0)} mm</b></span>
              </div>
            </div>

            {/* Arm Joint Jogs J1..J6 */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: 'var(--t3)', width: 44 }}>JOINTS:</span>
              {[0, 1, 2, 3, 4, 5].map((idx) => {
                const rad = robot?.arm_qpos_rad?.[idx] ?? 0;
                const deg = (rad * 57.2958).toFixed(0);
                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'rgba(255, 255, 255, 0.04)', padding: '2px 4px', borderRadius: 4, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <span style={{ fontSize: 9, color: 'var(--t3)' }}>J{idx + 1}:</span>
                    <span style={{ fontSize: 10, fontWeight: 600, minWidth: 26, textAlign: 'right' }}>{deg}°</span>
                    <button
                      className="btn btn--ghost"
                      style={{ padding: '0 4px', minHeight: 18, fontSize: 10, lineHeight: '18px' }}
                      onClick={() => controlActions.jogJoint(idx, -0.05)}
                      title={`Jog Joint ${idx + 1} -`}
                    >
                      -
                    </button>
                    <button
                      className="btn btn--ghost"
                      style={{ padding: '0 4px', minHeight: 18, fontSize: 10, lineHeight: '18px' }}
                      onClick={() => controlActions.jogJoint(idx, +0.05)}
                      title={`Jog Joint ${idx + 1} +`}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Repair Actions (Pick, Place, Gripper Toggle) */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
              <button
                className={`btn ${robot?.held_object_id ? 'btn--ghost' : 'btn--primary'}`}
                style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => controlActions.pick()}
                title="Grasp strainer cartridge when gripper contacts bail (P)"
              >
                <Zap size={12} />
                Pick Cartridge (P)
              </button>

              <button
                className={`btn ${robot?.held_object_id ? 'btn--primary' : 'btn--ghost'}`}
                style={{ fontSize: 11, padding: '4px 10px', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => controlActions.place()}
                title="Seat cartridge into isolated fixture & clear occlusion (O)"
              >
                <Sparkles size={12} />
                Seat in Fixture (O)
              </button>

              <button
                className="btn btn--ghost"
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => {
                  const cur = robot?.gripper_aperture_m ?? 0.04;
                  controlActions.setGripper(cur > 0.02 ? 0.01 : 0.05);
                }}
                title="Toggle Gripper Aperture (G)"
              >
                Toggle Gripper (G)
              </button>

              <div style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 'auto' }}>
                FIXTURE: <b style={{ color: mechanicalFixtures?.['strainer_fixture_01']?.cartridge_installed ? '#22c55e' : '#f59e0b' }}>
                  {mechanicalFixtures?.['strainer_fixture_01']?.cartridge_installed ? 'SEATED [FIT PASS]' : 'ISOLATED [READY]'}
                </b>
              </div>
            </div>
          </div>
        )}

        {/* V5 In-Pipe Deposit Cleaning HUD for INPIPE */}
        {isDriving && robotClass === 'inpipe' && (
          <div
            className="hud-inpipe-bar panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '8px 14px',
              background: 'rgba(10, 14, 22, 0.92)',
              backdropFilter: 'blur(14px)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
              margin: '0 auto 8px auto',
              maxWidth: 580,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399' }}>IN-PIPE CRAWLER REPAIR TOOL:</span>
              <span style={{ fontSize: 10, color: 'var(--t2)' }}>
                Fouling Deposit: <b style={{ color: (robot?.deposit_fouling_pct ?? 0.45) > 0.1 ? '#f87171' : '#22c55e' }}>
                  {((robot?.deposit_fouling_pct ?? 0.45) * 100).toFixed(0)}%
                </b>
              </span>
            </div>
            <button
              className="btn btn--primary"
              style={{ fontSize: 11, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => controlActions.cleanDeposit()}
              title="Actuate rotational brush and remove pipe deposit (T)"
            >
              <Zap size={12} />
              Brush Deposit (T)
            </button>
          </div>
        )}

        {/* Driving Telemetry & Controls Indicator */}
        {isDriving && (
          <div
            className="hud-drive-telemetry panel"
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '8px 14px',
              background: 'rgba(10, 14, 22, 0.9)',
              backdropFilter: 'blur(14px)',
              border: '1px solid rgba(34, 197, 94, 0.4)',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
            }}
          >
            {/* Throttle Gauge */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase' }}>Throttle</span>
              <div
                style={{
                  width: 50,
                  height: 6,
                  background: 'rgba(255, 255, 255, 0.1)',
                  borderRadius: 3,
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '50%',
                    width: `${Math.abs(ctl.input.throttle) * 50}%`,
                    transform: ctl.input.throttle < 0 ? 'translateX(-100%)' : 'none',
                    background: ctl.input.throttle < 0 ? '#f59e0b' : '#22c55e',
                  }}
                />
              </div>
            </div>

            {/* Steer Gauge */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase' }}>Steer</span>
              <div
                style={{
                  width: 50,
                  height: 6,
                  background: 'rgba(255, 255, 255, 0.1)',
                  borderRadius: 3,
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '50%',
                    width: `${Math.abs(ctl.input.steer) * 50}%`,
                    transform: ctl.input.steer < 0 ? 'translateX(-100%)' : 'none',
                    background: '#2fd3e8',
                  }}
                />
              </div>
            </div>

            {/* Brake indicator */}
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 4,
                background: ctl.input.brake ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                color: ctl.input.brake ? '#f87171' : 'var(--t3)',
                border: ctl.input.brake ? '1px solid #ef4444' : 'none',
              }}
            >
              BRAKE
            </div>

            {/* Keyboard legend */}
            <div style={{ fontSize: 10, color: 'var(--t2)', display: 'flex', gap: 8 }}>
              <span><b style={{ color: '#fff' }}>W/S</b> Throttle</span>
              <span><b style={{ color: '#fff' }}>A/D</b> Steer</span>
              <span><b style={{ color: '#fff' }}>Space</b> Brake</span>
              <span><b style={{ color: '#fff' }}>L</b> Lamp</span>
              <span><b style={{ color: '#fff' }}>E</b> Tool</span>
              <span><b style={{ color: '#fff' }}>C</b> Cam</span>
              <span><b style={{ color: '#fff' }}>Esc</b> Release</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
