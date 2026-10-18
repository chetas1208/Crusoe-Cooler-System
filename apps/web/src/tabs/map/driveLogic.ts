/**
 * Pure logic behind the Map tab's drive pad, arm panel and keyboard: no React, no store, so it is unit-tested in node.
 */
import { ARM_JOINT_COUNT, JOG_STEP_RAD } from '@loopkeeper/core/control';

export type PadDir = 'fwd' | 'rev' | 'left' | 'right';
export type Power = 0.3 | 0.6 | 1;
export const POWERS: ReadonlyArray<{ id: string; value: Power; label: string }> = [
  { id: '30', value: 0.3, label: '30 %' },
  { id: '60', value: 0.6, label: '60 %' },
  { id: '100', value: 1, label: '100 %' },
];

/** Axes a single held pad button contributes (the session takes the strongest per axis across sources, so two held buttons combine). */
export function padAxes(dir: PadDir, power: number): { throttle: number; steer: number } {
  const p = Math.max(0.05, Math.min(1, power));
  switch (dir) {
    case 'fwd':
      return { throttle: p, steer: 0 };
    case 'rev':
      return { throttle: -p, steer: 0 };
    case 'left':
      return { throttle: 0, steer: -Math.max(0.5, p) };
    case 'right':
      return { throttle: 0, steer: Math.max(0.5, p) };
  }
}

/** Calls `fire` now and then every `intervalMs` until stopped. Never stacks timers: start() on a running repeater is a no-op. */
export function createHoldRepeater(fire: () => void, intervalMs = 130) {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer) return;
      fire();
      timer = setInterval(fire, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get held() {
      return timer !== null;
    },
  };
}

export const clampJoint = (i: number) => Math.max(0, Math.min(ARM_JOINT_COUNT - 1, Math.trunc(i)));

export type KeyAction =
  | { kind: 'jog'; dir: 1 | -1 }
  | { kind: 'joint'; step: 1 | -1 }
  | { kind: 'arm_home' }
  | { kind: 'arm_stow' }
  | { kind: 'pick' }
  | { kind: 'place' }
  | { kind: 'gripper' }
  | { kind: 'brush' }
  | { kind: 'lamp' }
  | { kind: 'scan' };

export interface KeyEventLike {
  code: string;
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Non-driving keys, per robot class, so "same class, same controls" is one table. WASD / arrows / Space (drive), C / H / Shift+1..5 (camera) and Esc
 * are handled by the drive controller before this.
 *   both       L lamp - E scan
 *   INPIPE     T brush
 *   OUTRIG     [ ] select joint - , . jog selected joint - G gripper - P pick - O place - Home / End arm home / stow
 */
export function classKeyAction(e: KeyEventLike, cls: 'inpipe' | 'outrig'): KeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'l') return { kind: 'lamp' };
  if (k === 'e') return { kind: 'scan' };
  if (cls === 'inpipe') return k === 't' ? { kind: 'brush' } : null;
  switch (e.code === 'Home' || e.code === 'End' ? e.code : k) {
    case '[':
      return { kind: 'joint', step: -1 };
    case ']':
      return { kind: 'joint', step: 1 };
    case ',':
      return { kind: 'jog', dir: -1 };
    case '.':
      return { kind: 'jog', dir: 1 };
    case 'g':
      return { kind: 'gripper' };
    case 'p':
      return { kind: 'pick' };
    case 'o':
      return { kind: 'place' };
    case 'Home':
      return { kind: 'arm_home' };
    case 'End':
      return { kind: 'arm_stow' };
    default:
      return null;
  }
}

export const jogDelta = (dir: 1 | -1, fine = false) => dir * (fine ? JOG_STEP_RAD / 2 : JOG_STEP_RAD);

/** Help-popover rows. Same table the keys are built from, so the help never drifts from what works. */
export const SHORTCUTS: ReadonlyArray<{ group: string; cls: 'both' | 'inpipe' | 'outrig'; keys: string; does: string }> = [
  { group: 'Drive', cls: 'both', keys: 'W A S D / arrows', does: 'Throttle and steer (hold)' },
  { group: 'Drive', cls: 'both', keys: 'Space', does: 'Brake (hold)' },
  { group: 'Drive', cls: 'both', keys: 'Esc', does: 'Release control to the agent' },
  { group: 'Tools', cls: 'both', keys: 'L', does: 'Lamp on / off' },
  { group: 'Tools', cls: 'both', keys: 'E', does: 'Scan' },
  { group: 'Tools', cls: 'inpipe', keys: 'T', does: 'Brush the deposit' },
  { group: 'Arm', cls: 'outrig', keys: '[  ]', does: 'Select previous / next joint' },
  { group: 'Arm', cls: 'outrig', keys: ',  .', does: 'Jog the selected joint (hold to repeat)' },
  { group: 'Arm', cls: 'outrig', keys: 'G', does: 'Gripper open / close' },
  { group: 'Arm', cls: 'outrig', keys: 'P / O', does: 'Pick / Place' },
  { group: 'Arm', cls: 'outrig', keys: 'Home / End', does: 'Arm home / stow' },
  { group: 'View', cls: 'both', keys: 'C', does: 'Cycle camera' },
  { group: 'View', cls: 'both', keys: 'H', does: 'Hide / show the HUD' },
  { group: 'View', cls: 'both', keys: 'Shift + 1..5', does: 'First-person view slots' },
];
