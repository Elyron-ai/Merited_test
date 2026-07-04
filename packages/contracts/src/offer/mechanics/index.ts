import { z } from 'zod';
import { ACCESS_MECHANICS } from './access.js';
import { LIFECYCLE_MECHANICS } from './lifecycle.js';
import { POINTS_MECHANICS } from './points.js';
import { PRICE_MECHANICS } from './price.js';
import { TIER_MECHANICS } from './tier.js';

export * from './access.js';
export * from './lifecycle.js';
export * from './points.js';
export * from './price.js';
export * from './tier.js';

/** All 27 mechanics variants (BUILD-SPEC §3, FND D10, SYN-28). */
export const ALL_MECHANICS = [
  ...PRICE_MECHANICS,
  ...POINTS_MECHANICS,
  ...TIER_MECHANICS,
  ...LIFECYCLE_MECHANICS,
  ...ACCESS_MECHANICS,
] as const;

/**
 * ONE discriminated union, ONE offers table — do not build 27 tables
 * (BUILD-SPEC §3, §5.1).
 */
export const OfferMechanics = z.discriminatedUnion('type', [
  ...PRICE_MECHANICS,
  ...POINTS_MECHANICS,
  ...TIER_MECHANICS,
  ...LIFECYCLE_MECHANICS,
  ...ACCESS_MECHANICS,
]);

export type OfferMechanics = z.infer<typeof OfferMechanics>;
export type MechanicsType = OfferMechanics['type'];
