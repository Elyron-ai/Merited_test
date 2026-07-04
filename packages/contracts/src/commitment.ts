import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';
import { IdentityTier } from './tier.js';

/**
 * Committed Offer Record (COR) — immutable once countersigned; the unit of
 * commercial truth (BUILD-SPEC §3, architecture §2.2). Creation is trio scope.
 */
export const Commitment = z
  .object({
    commitment_id: Id('com'),
    merchant_id: Id('mer'),
    offer_ref: Id('off'),
    bounty: z.object({
      type: z.enum(['fixed', 'pct_of_order']),
      amount: Money.optional(),
      pct_bps: z.number().int().positive().optional(),
    }),
    take_rate_bps: z.number().int().nonnegative(),
    agent_commission_bps: z.number().int().nonnegative(),
    terms: z.object({
      attribution_window_s: z.number().int().positive(),
      eligible_identity_tiers: z.array(IdentityTier),
      max_conversions: z.number().int().positive().nullable(),
      clawback_window_s: z.number().int().nonnegative(),
      valid_from: z.string().datetime(),
      valid_until: z.string().datetime(),
    }),
    merchant_sig: z.string(),
    platform_sig: z.string(),
  })
  .superRefine((commitment, ctx) => {
    if (commitment.bounty.type === 'fixed' && commitment.bounty.amount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bounty', 'amount'],
        message: 'fixed bounty requires amount',
      });
    }
    if (commitment.bounty.type === 'pct_of_order' && commitment.bounty.pct_bps === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bounty', 'pct_bps'],
        message: 'pct_of_order bounty requires pct_bps',
      });
    }
  });

export type Commitment = z.infer<typeof Commitment>;
