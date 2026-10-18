/**
 * Canonical product branding configuration for Crusoe Cooler System.
 * Single source of truth across web, mobile, and documentation.
 */
export const PRODUCT_BRAND = {
  name: 'Crusoe Cooler System',
  shortName: 'Crusoe Cooler',
  tagline: 'Autonomous physical-AI maintenance twin for liquid-cooled data centers',
  legacyNames: ['LOOPKEEPER', 'LoopKeeper', 'Loop Keeper', 'loopkeeper', 'loop-keeper', 'loop_keeper'] as const,
  version: '1.0.0',
} as const;

export type ProductBrand = typeof PRODUCT_BRAND;
