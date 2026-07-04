import { z } from 'zod';
import { Id } from './ids.js';
import type { OfferQuote } from './quote.js';

/**
 * Approval — consumer authorisation of a specific quote, wallet path
 * (BUILD-SPEC §3, §6.4). Single-use and quote-bound; `exp = quote.expires_at`.
 */
export const Approval = z.object({
  approval_id: Id('apr'),
  mandate_id: Id('mnd'),
  quote_id: Id('qte'),
  mode: z.enum(['explicit', 'pre_authorised']),
  approved_at: z.string().datetime(),
  exp: z.string().datetime(), // = quote.expires_at
  attestation: z.string(), // signed via Signer
});

export type Approval = z.infer<typeof Approval>;

/**
 * §6.4 semantics as a shared predicate: an approval is valid for a quote iff
 * it is bound to that quote and expires exactly with it.
 */
export const approvalIsQuoteBound = (
  approval: Pick<Approval, 'quote_id' | 'exp'>,
  quote: Pick<OfferQuote, 'quote_id' | 'expires_at'>,
): boolean => approval.quote_id === quote.quote_id && approval.exp === quote.expires_at;
