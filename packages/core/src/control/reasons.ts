import type { ControlReason } from '../contracts.control';

export type StopReason = ControlReason;

/** Banner text for an unplanned stop. Plain verbs, says what happened and what the robot is doing. */
export const REASON_LABEL: Record<ControlReason, string> = {
  operator_release: 'Control released.',
  deadman_timeout: 'Safety stop. The robot stopped because no heartbeat reached it (deadman timeout).',
  lease_expired: 'Safety stop. The control lease expired.',
  client_hidden: 'Safety stop. The window lost focus or was hidden, so the robot was stopped.',
  client_disconnect: 'Safety stop. The live stream disconnected, so the robot was stopped.',
  link_lost: 'Link lost. Safety stop: no acknowledgement came back from the robot.',
  safety_interlock: 'Safety stop. A safety interlock isolated this section.',
  low_battery: 'Safety stop. Battery too low to keep driving.',
  operator_stop: 'Stopped by the operator.',
  safe_hold_timeout: 'The safe hold timed out and the agent took the robot back.',
  resume_blocked: 'The agent could not find a legal route to resume, so the robot is holding.',
};

/** Fragment used inside server refusals ("Control was withdrawn: …"). */
export const REASON_TEXT: Record<ControlReason, string> = {
  operator_release: 'released by the operator',
  deadman_timeout: 'no heartbeat (deadman timeout)',
  lease_expired: 'the lease expired',
  client_hidden: 'the operator window was hidden',
  client_disconnect: 'the operator disconnected',
  link_lost: 'the control link was lost',
  safety_interlock: 'a safety interlock closed this section',
  low_battery: 'battery too low',
  operator_stop: 'operator stop',
  safe_hold_timeout: 'safe-hold timeout',
  resume_blocked: 'the agent could not find a legal route to resume',
};

/** A server refusal turned into words an operator can act on, plus what (if anything) they can do about it. */
export interface PlainRefusal {
  /** machine key of the refusal, as the backend worded it ("battery_depleted", "lease_conflict", ...) */
  key: string;
  /** one plain sentence: what is wrong */
  text: string;
  /** what the operator can do next, if there is something */
  hint?: string;
  /** true when the robot should be sent back to its dock / charger to recover */
  dockable: boolean;
  /** true when retrying in a moment is reasonable */
  retry: boolean;
}

const REFUSALS: Array<[RegExp, Omit<PlainRefusal, 'key'>]> = [
  [/^battery_depleted|^low_battery/, { text: 'Battery is too low to drive: manual control needs more than 8 %.', hint: 'Send it to its dock to recharge, or pick a robot with charge.', dockable: true, retry: false }],
  [/^lease_conflict|^lease_held/, { text: 'Another operator already holds this robot.', hint: 'Wait for them to release it.', dockable: false, retry: true }],
  [/^robot_busy/, { text: 'The robot is in the middle of a repair action.', hint: 'Manual control opens when the job finishes.', dockable: false, retry: true }],
  [/^robot_in_safe_hold/, { text: 'The robot is in a safe hold after the last session.', hint: 'Acknowledge the hold, then take control again in a moment.', dockable: false, retry: true }],
  [/^robot_signal_unavailable/, { text: 'This crawler is not inside a pipe segment, so there is nothing to drive.', hint: 'Send it to a pipe segment from the route panel.', dockable: false, retry: false }],
  [/^manual_control_not_supported/, { text: 'This robot type has no manual drive.', dockable: false, retry: false }],
  [/^unknown_robot/, { text: 'The server does not know this robot.', dockable: false, retry: false }],
  [/^not_controllable|^robot is not drivable/, { text: 'The server says this robot cannot be driven right now.', dockable: false, retry: true }],
  [/^topology_revision_mismatch|^topology_changed/, { text: 'The facility layout changed while you were connecting.', hint: 'Try again.', dockable: false, retry: true }],
  [/^stale_world_version/, { text: 'The view was out of date when you asked. Try again.', dockable: false, retry: true }],
  [/^no_manipulator/, { text: 'Only OUTRIG rovers carry the arm.', dockable: false, retry: false }],
  [/^rate limit/, { text: 'Too many control requests in a moment. Slow down for a second.', dockable: false, retry: true }],
];

/**
 * Plain-words version of a backend refusal reason. Unknown reasons are shown verbatim (never hidden), with the machine prefix kept
 * so support can search for it.
 */
export function plainRefusal(reason: string | undefined | null): PlainRefusal {
  const raw = (reason ?? '').trim();
  const key = raw.split(/[:\s]/)[0] || 'refused';
  for (const [re, v] of REFUSALS) if (re.test(raw)) return { key, ...v };
  return { key, text: raw ? raw.replace(/_/g, ' ') : 'The server refused the request.', dockable: false, retry: false };
}
