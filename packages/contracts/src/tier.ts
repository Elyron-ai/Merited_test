import { z } from 'zod';

/** Identity tiers (BUILD-SPEC §3, architecture §3.3). */
export const IdentityTier = z.enum(['T1', 'T2', 'T3']);
export type IdentityTier = z.infer<typeof IdentityTier>;
