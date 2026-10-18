/**
 * One plain answer to "what is this robot's control doing right now?" for the Map tab, from the control session and the robot record.
 * Pure: pass `now` in. The UI renders `label` + `detail` and colours by `tone`; nothing here talks to the network.
 */
import type { ControlSessionState } from './session';
import { plainRefusal } from './reasons';

export type DriveKind = 'idle' | 'acquiring' | 'manual' | 'degraded' | 'safe_hold' | 'stopped' | 'refused' | 'releasing' | 'foreign';
export interface DriveStatus {
  kind: DriveKind;
  label: string;
  detail: string;
  tone: 'neutral' | 'ok' | 'warn' | 'bad';
}

export const DEGRADED_ACK_MS = 450;
export const DEGRADED_RTT_MS = 700;

export interface RobotLike {
  id: string;
  mode?: string;
  battery_pct?: number;
  control?: { authority?: string; controller_state?: string; holder?: string; last_reason?: string } | null;
}

export function driveStatus(ctl: Pick<ControlSessionState, 'state' | 'robotId' | 'ackAt' | 'rttMs' | 'linkOk' | 'stop' | 'refusal' | 'clientId'>, robot: RobotLike | undefined, now: number): DriveStatus {
  const mine = !!robot && ctl.robotId === robot.id;
  if (mine) {
    switch (ctl.state) {
      case 'LEASE_REQUESTED':
        return { kind: 'acquiring', label: 'ACQUIRING', detail: 'Asking the server for control. The robot freezes its mission first, which can take a second.', tone: 'warn' };
      case 'MANUAL_ARMED':
      case 'MANUAL_DRIVING': {
        const silent = now - ctl.ackAt;
        if (!ctl.linkOk || silent > DEGRADED_ACK_MS || (ctl.rttMs ?? 0) > DEGRADED_RTT_MS) {
          return { kind: 'degraded', label: 'LINK DEGRADED', detail: !ctl.linkOk ? 'Commands are not getting through. The robot brakes by itself if this lasts.' : `Slow answers (${ctl.rttMs === null ? 'no ack' : Math.round(ctl.rttMs) + ' ms'}). Drive gently; the robot brakes by itself if it goes silent.`, tone: 'warn' };
        }
        return { kind: 'manual', label: 'MANUAL', detail: ctl.state === 'MANUAL_DRIVING' ? 'You are driving.' : 'You hold control. The robot waits for your input.', tone: 'ok' };
      }
      case 'RELEASE_PENDING':
        return { kind: 'releasing', label: 'RELEASING', detail: 'Handing the robot back to the agent.', tone: 'warn' };
      case 'SAFE_STOP':
        return { kind: 'stopped', label: 'STOPPED', detail: ctl.stop?.text ?? 'The robot was stopped.', tone: 'bad' };
      case 'SAFE_HOLD':
        return { kind: 'safe_hold', label: 'SAFE HOLD', detail: 'The robot is holding position. Acknowledge, then take control again.', tone: 'bad' };
      default:
        break;
    }
  }
  if (ctl.refusal && ctl.refusal.robotId === robot?.id) {
    const p = plainRefusal(ctl.refusal.reason);
    return { kind: 'refused', label: 'REFUSED', detail: p.hint ? `${p.text} ${p.hint}` : p.text, tone: 'bad' };
  }
  if (!robot) return { kind: 'idle', label: 'NO ROBOT', detail: 'Select a robot.', tone: 'neutral' };
  const c = robot.control;
  if (robot.mode === 'SAFE_HOLD' || c?.controller_state === 'SAFE_HOLD') return { kind: 'safe_hold', label: 'SAFE HOLD', detail: 'The server is holding this robot. Take control to move it.', tone: 'bad' };
  if (c && c.authority === 'HUMAN' && c.holder && c.holder !== ctl.clientId) return { kind: 'foreign', label: 'HELD', detail: 'Another operator holds this robot.', tone: 'warn' };
  return { kind: 'idle', label: 'AUTO', detail: 'The agent is in charge. Take control to drive.', tone: 'neutral' };
}

/** Why Take Control is unavailable before even asking the server, or '' when it is fine to try. Client-side mirror of the backend gates. */
export function takeControlBlocker(robot: RobotLike | undefined, live: boolean, previewOn: boolean): string {
  if (!robot) return 'Select a robot first.';
  if (!live) return 'The live stream is not connected, so control cannot be granted.';
  if (previewOn) return 'Exit the ghost preview first.';
  if (typeof robot.battery_pct === 'number' && robot.battery_pct <= 8) return plainRefusal('battery_depleted').text;
  if (robot.mode === 'WORKING') return 'Mid-repair: the server refuses manual control until the job finishes.';
  return '';
}
