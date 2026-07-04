import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';
import { IdentityTier } from './tier.js';
import type { AttributionTokenClaims } from './token.js';

/**
 * Offer Quote — the unit of response on the read path, v1.1 (BUILD-SPEC §3,
 * §4). A priced promise, not a reservation. `token` is null for
 * anonymous/unregistered reads (visible but not payable).
 */
export const OfferQuote = z.object({
  quote_id: Id('qte'),
  offer_id: Id('off'),
  commitment_id: Id('com'),
  /** null on anonymous/unregistered reads — the quote persists regardless
   * (§5.6a: quote ids stay honest), it is simply unpayable. */
  agent_id: Id('agt').nullable(),
  consumer_ref: Id('usr').nullable(),
  tier: IdentityTier,
  segment: z.string(), // categorisation output
  price: z.object({
    list: Money,
    final: Money,
    mechanics_applied: z.array(z.string()),
  }),
  token: z.string().nullable(),
  expires_at: z.string().datetime(), // default now+15min, always ≤ token exp
});

export type OfferQuote = z.infer<typeof OfferQuote>;

/**
 * §3 invariant: `expires_at` always ≤ token `exp`. CORE-10 clamps at issue
 * time; this helper is the shared assertion (also used in property tests).
 */
export const quoteExpiryWithinToken = (
  quote: Pick<OfferQuote, 'expires_at'>,
  claims: Pick<AttributionTokenClaims, 'exp'>,
): boolean => Math.floor(Date.parse(quote.expires_at) / 1000) <= claims.exp;
