import { z } from 'zod';
import { Id } from '../ids.js';
import { IdentityTier } from '../tier.js';
import { OfferMechanics } from './mechanics/index.js';

/** Offer — ONE table, ONE schema, discriminated mechanics union (BUILD-SPEC §3). */
export const Offer = z.object({
  offer_id: Id('off'),
  merchant_id: Id('mer'),
  title: z.string(),
  description: z.string(),
  mechanics: OfferMechanics,
  sku_scope: z.union([z.literal('all'), z.array(z.string())]),
  identity_tiers: z.array(IdentityTier),
  stacking_group: z.string().nullable(),
  status: z.enum(['draft', 'live', 'paused', 'ended']),
  valid_from: z.string().datetime(),
  valid_until: z.string().datetime(),
});

export type Offer = z.infer<typeof Offer>;
