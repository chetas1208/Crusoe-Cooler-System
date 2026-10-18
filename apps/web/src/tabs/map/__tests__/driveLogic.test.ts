import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, classKeyAction, clampJoint, createHoldRepeater, jogDelta, padAxes } from '../driveLogic';

const key = (k: string, code = `Key${k.toUpperCase()}`, extra = {}) => ({ key: k, code, ...extra });

describe('padAxes', () => {
  it('maps each button to its axis at the chosen power', () => {
    expect(padAxes('fwd', 0.6)).toEqual({ throttle: 0.6, steer: 0 });
    expect(padAxes('rev', 0.3)).toEqual({ throttle: -0.3, steer: 0 });
    expect(padAxes('left', 1)).toEqual({ throttle: 0, steer: -1 });
    expect(padAxes('right', 0.3).steer).toBe(0.5); // a turn never gets weaker than half, or the robot would not steer at 30 %
  });
  it('clamps absurd power', () => {
    expect(padAxes('fwd', 9).throttle).toBe(1);
    expect(padAxes('fwd', -3).throttle).toBe(0.05);
  });
});

describe('createHoldRepeater', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('fires at once, repeats while held, stops on release and never stacks timers', () => {
    const fire = vi.fn();
    const r = createHoldRepeater(fire, 100);
    r.start();
    r.start();
    r.start();
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(350);
    expect(fire).toHaveBeenCalledTimes(4);
    expect(r.held).toBe(true);
    r.stop();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(4);
    expect(r.held).toBe(false);
    r.stop(); // idempotent
    r.start();
    expect(fire).toHaveBeenCalledTimes(5);
    r.stop();
  });
});

describe('class key map', () => {
  it('OUTRIG has the arm keys, INPIPE does not', () => {
    expect(classKeyAction(key('p'), 'outrig')).toEqual({ kind: 'pick' });
    expect(classKeyAction(key('P'), 'outrig')).toEqual({ kind: 'pick' });
    expect(classKeyAction(key('o'), 'outrig')).toEqual({ kind: 'place' });
    expect(classKeyAction(key('g'), 'outrig')).toEqual({ kind: 'gripper' });
    expect(classKeyAction(key(']', 'BracketRight'), 'outrig')).toEqual({ kind: 'joint', step: 1 });
    expect(classKeyAction(key('[', 'BracketLeft'), 'outrig')).toEqual({ kind: 'joint', step: -1 });
    expect(classKeyAction(key('.', 'Period'), 'outrig')).toEqual({ kind: 'jog', dir: 1 });
    expect(classKeyAction(key(',', 'Comma'), 'outrig')).toEqual({ kind: 'jog', dir: -1 });
    expect(classKeyAction({ key: 'Home', code: 'Home' }, 'outrig')).toEqual({ kind: 'arm_home' });
    expect(classKeyAction({ key: 'End', code: 'End' }, 'outrig')).toEqual({ kind: 'arm_stow' });
    for (const k of ['p', 'o', 'g', ']', ',']) expect(classKeyAction(key(k), 'inpipe')).toBeNull();
    expect(classKeyAction({ key: 'Home', code: 'Home' }, 'inpipe')).toBeNull();
  });
  it('INPIPE brushes with T; OUTRIG does not', () => {
    expect(classKeyAction(key('t'), 'inpipe')).toEqual({ kind: 'brush' });
    expect(classKeyAction(key('t'), 'outrig')).toBeNull();
  });
  it('lamp and scan are the same on both classes', () => {
    for (const c of ['inpipe', 'outrig'] as const) {
      expect(classKeyAction(key('l'), c)).toEqual({ kind: 'lamp' });
      expect(classKeyAction(key('E'), c)).toEqual({ kind: 'scan' });
    }
  });
  it('ignores browser shortcuts', () => {
    expect(classKeyAction(key('p', 'KeyP', { ctrlKey: true }), 'outrig')).toBeNull();
    expect(classKeyAction(key('l', 'KeyL', { metaKey: true }), 'inpipe')).toBeNull();
  });
  it('every documented class shortcut resolves to an action (the help never lies)', () => {
    const probe: Record<string, Array<[string, string]>> = {
      L: [['l', 'KeyL']], E: [['e', 'KeyE']], T: [['t', 'KeyT']], '[  ]': [['[', 'BracketLeft'], [']', 'BracketRight']], ',  .': [[',', 'Comma'], ['.', 'Period']], G: [['g', 'KeyG']], 'P / O': [['p', 'KeyP'], ['o', 'KeyO']], 'Home / End': [['Home', 'Home'], ['End', 'End']],
    };
    for (const s of SHORTCUTS.filter((x) => x.cls !== 'both' || probe[x.keys])) {
      const keys = probe[s.keys];
      if (!keys) continue;
      for (const [k, code] of keys) {
        for (const cls of (s.cls === 'both' ? ['inpipe', 'outrig'] : [s.cls]) as Array<'inpipe' | 'outrig'>) expect(classKeyAction({ key: k, code }, cls), `${s.keys} on ${cls}`).not.toBeNull();
      }
    }
  });
});

describe('small helpers', () => {
  it('joint index is clamped to 0..5', () => {
    expect([clampJoint(-3), clampJoint(2), clampJoint(9), clampJoint(2.7)]).toEqual([0, 2, 5, 2]);
  });
  it('jog delta direction and fine step', () => {
    expect(jogDelta(1)).toBeCloseTo(0.05);
    expect(jogDelta(-1)).toBeCloseTo(-0.05);
    expect(jogDelta(1, true)).toBeCloseTo(0.025);
  });
});
