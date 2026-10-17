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
