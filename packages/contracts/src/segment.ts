import { z } from 'zod';

/**
 * Consumer segments (CORE-4, §5.3 "categorisation"): the FROZEN enum of
 * segment names — deterministic output of `segmentFor(tier, loyaltyTier,
 * newVsReturning)`, consumed by decisioning (B7) and stamped on every quote.
 * T1 splits by loyalty tier and recency; T2 by recency; T3 is acquisition.
 */
export const SEGMENTS = [
  't1-gold-new',
  't1-gold-returning',
  't1-member-new',
  't1-member-returning',
  't2-new',
  't2-returning',
  't3-acquisition',
] as const;

export const Segment = z.enum(SEGMENTS);
export type Segment = z.infer<typeof Segment>;
