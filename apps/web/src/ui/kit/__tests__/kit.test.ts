import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, nextIndex } from '../a11y';

const css = readFileSync(new URL('../../../styles/tokens.css', import.meta.url), 'utf8');
const tok = (n: string) => {
  const m = css.match(new RegExp(`${n}:\\s*([^;/]+?)\\s*(?:;|/\\*)`));
  if (!m) throw new Error(`missing token ${n}`);
  return m[1].trim();
};
const BG = tok('--bg');

describe('graphite theme contrast (WCAG AA)', () => {
  const surfaces = ['--bg', '--panel-solid', '--lk-surface-1'].map((s) => (s === '--lk-surface-1' ? '#161a22' : tok(s)));
  it.each(['--t1', '--t2', '--t3', '--accent', '--nominal', '--watch', '--warning', '--critical', '--sentinel', '--inpipe'])('%s text >= 4.5:1 on graphite surfaces', (t) => {
    for (const s of surfaces) expect(contrast(tok(t), s, BG)).toBeGreaterThanOrEqual(4.5);
  });
  it('t3 holds on the raised fill used by segmented/menu items', () => {
    expect(contrast(tok('--t3'), 'rgba(255,255,255,0.075)', tok('--panel-solid'))).toBeGreaterThanOrEqual(4.5);
  });
  it('tinted badge text stays >= 4.5:1 for every tone', () => {
    const tones: Array<[string, string]> = [['--nominal', '65,214,163'], ['--watch', '231,203,75'], ['--warning', '255,154,60'], ['--critical', '255,79,79'], ['--sentinel', '167,139,250'], ['--inpipe', '47,211,232'], ['--accent', '91,227,208'], ['--isolated', '139,147,167']];
    for (const [t, rgb] of tones) expect(contrast(tok(t), `rgba(${rgb},0.1)`, tok('--panel-solid'))).toBeGreaterThanOrEqual(4.5);
  });
  it('danger button text on its tint and primary ink on accent', () => {
    expect(contrast('#ff8f8f', 'rgba(255,79,79,0.13)', tok('--panel-solid'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ff8f8f', 'rgba(255,79,79,0.22)', tok('--panel-solid'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#04201c', tok('--accent'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#04201c', '#7aedde')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tok('--warning'), 'rgba(255,154,60,0.21)', tok('--panel-solid'))).toBeGreaterThanOrEqual(4.5);
  });
  it('control boundary (--lk-bd-ctl) is >= 3:1 against the panel (WCAG 1.4.11)', () => {
    expect(contrast(tok('--lk-bd-ctl'), tok('--panel-solid'))).toBeGreaterThanOrEqual(3);
  });
});

describe('type + target tokens', () => {
  it('no type token below 12px', () => {
    for (const m of css.matchAll(/--lk-fs-[a-z0-9]+:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });
  it('coarse hit target is 44px', () => expect(tok('--lk-hit')).toBe('44px'));
});

describe('roving tabindex', () => {
  it('arrows wrap and skip disabled', () => {
    expect(nextIndex('ArrowRight', 2, 3, 'horizontal')).toBe(0);
    expect(nextIndex('ArrowLeft', 0, 3, 'horizontal')).toBe(2);
    expect(nextIndex('ArrowRight', 0, 3, 'horizontal', (i) => i === 1)).toBe(2);
    expect(nextIndex('Home', 2, 4, 'horizontal')).toBe(0);
    expect(nextIndex('End', 0, 4, 'horizontal')).toBe(3);
    expect(nextIndex('ArrowDown', 0, 3, 'horizontal')).toBeNull();
    expect(nextIndex('ArrowDown', 0, 3, 'vertical')).toBe(1);
  });
});
