import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';

/**
 * Conversion Claim (merchant → platform), BUILD-SPEC §3. The token is
 * required — no token, no bounty (P2, SYN-5/A1): token-less orders are
 * dropped at the adapter, never claimed.
 */
export const ConversionClaim = z.object({
  claim_id: Id('clm'),
  merchant_id: Id('mer'),
  attribution_token: z.string(),
  order: z.object({
    order_ref_hash: z.string(),
    gross_value: Money,
    ts: z.string().datetime(),
  }),
  merchant_sig: z.string(),
});

export type ConversionClaim = z.infer<typeof ConversionClaim>;
