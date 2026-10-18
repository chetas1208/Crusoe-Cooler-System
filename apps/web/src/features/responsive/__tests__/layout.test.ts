import { describe, expect, it } from 'vitest';
import { computeLayout } from '../layout';

const L = (w: number, h: number, coarse = false) => computeLayout(w, h, coarse);

describe('layout model', () => {
  it('classifies the test matrix', () => {
    expect(L(390, 844, true)).toMatchObject({ layout: 'phone-portrait', compact: true, host: 'sheet' });
    expect(L(844, 390, true)).toMatchObject({ layout: 'phone-landscape', compact: true, host: 'drawer' });
    expect(L(932, 430, true)).toMatchObject({ layout: 'phone-landscape', compact: true, host: 'drawer' });
    expect(L(768, 1024, true)).toMatchObject({ layout: 'tablet', compact: true, host: 'sheet' });
    expect(L(820, 1180, true)).toMatchObject({ layout: 'tablet', compact: true, host: 'sheet' });
    expect(L(1024, 768, true)).toMatchObject({ layout: 'tablet', compact: false, host: 'dock' });
    expect(L(1180, 820, true)).toMatchObject({ layout: 'tablet', compact: false, host: 'dock' });
    expect(L(1280, 720)).toMatchObject({ layout: 'desktop', compact: false, host: 'dock' });
    expect(L(1440, 900)).toMatchObject({ layout: 'desktop', compact: false, host: 'dock' });
  });
  it('a touch tablet at desktop size stays a tablet; a fine-pointer small window is a tablet too', () => {
    expect(L(1366, 1024, true).layout).toBe('tablet');
    expect(L(1100, 700).layout).toBe('tablet');
  });
  it('rotation keeps the same chrome family for phones and never changes the feature set (only the host)', () => {
    const p = L(390, 844, true);
    const l = L(844, 390, true);
    expect(p.compact).toBe(l.compact);
    expect(p.host).not.toBe('dock');
    expect(l.host).toBe('drawer');
  });
  it('short landscape is a drawer, never a dock', () => {
    expect(L(1000, 480).host).toBe('drawer');
    expect(L(1000, 519).host).toBe('drawer');
    expect(L(1000, 520).host).toBe('dock');
  });
});
