import { describe, expect, it } from 'vitest';
import { CAUSE_LABEL, KNOWN_FAULT_KINDS, faultDescription, faultLabel } from '../src';

describe('faultLabels', () => {
  it('labels and describes every known kind', () => {
    expect(KNOWN_FAULT_KINDS).toContain('manifold_leak');
    for (const k of KNOWN_FAULT_KINDS) {
      expect(faultLabel(k).length).toBeGreaterThan(2);
      expect(faultDescription(k).length).toBeGreaterThan(20);
      expect(CAUSE_LABEL[k]).toBe(faultLabel(k));
    }
  });
  it('renders unknown kinds without throwing', () => {
    expect(faultLabel('brand_new_hazard')).toBe('Brand new hazard');
    expect(faultLabel(undefined)).toBe('Unknown fault');
    expect(faultLabel('__proto__')).toBe('Proto');
    expect(faultDescription(42)).toContain('Unknown fault');
    expect((CAUSE_LABEL as Record<string, string>)['brand_new_hazard']).toBe('Brand new hazard');
  });
});
