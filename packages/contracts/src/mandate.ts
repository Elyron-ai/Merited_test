import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';

/**
 * Mandate — the consumer's grant of authority to an agent (BUILD-SPEC §3,
 * §6.1; architecture §4.1). Attenuation never escalation. Includes
 * `pre_authorised_up_to` per §6.1 (SYN-15). Refinements encode the limit
 * ordering: pre_authorised_up_to ≤ per_txn ≤ per_month.
 */
export const Mandate = z
  .object({
    mandate_id: Id('mnd'),
    consumer_ref: Id('usr'),
    agent_id: Id('agt'),
    scopes: z.array(z.enum(['offers:read', 'loyalty:read', 'checkout:execute'])),
    limits: z.object({
      per_txn: Money,
      per_month: Money,
      categories: z.array(z.string()),
    }),
    merchants: z.array(z.string()), // ids or '*'
    data_sharing: z.object({
      email: z.boolean(),
      purchase_history: z.boolean(),
      loyalty_ids: z.boolean(),
    }),
    pre_authorised_up_to: Money,
    status: z.enum(['active', 'revoked', 'expired']),
    exp: z.string().datetime(),
    attestation: z.string(),
  })
  .superRefine((mandate, ctx) => {
    if (mandate.limits.per_txn.amount > mandate.limits.per_month.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limits', 'per_txn'],
        message: 'per_txn limit cannot exceed per_month limit',
      });
    }
    if (mandate.pre_authorised_up_to.amount > mandate.limits.per_txn.amount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pre_authorised_up_to'],
        message: 'pre_authorised_up_to cannot exceed the per_txn limit',
      });
    }
  });

export type Mandate = z.infer<typeof Mandate>;
