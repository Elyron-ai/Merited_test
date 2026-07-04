import { z } from 'zod';
import { Id } from './ids.js';
import { OfferQuote } from './quote.js';
import { RejectionReasonCode } from './reasons.js';
import { EntrySet } from './trio/index.js';

/**
 * Public REST wire shapes not already covered by richer contracts
 * (CORE-12/13, §4). The SDK validates every response against these — an
 * SDK consumer can trust the types at runtime (§1: contracts is the single
 * source; the SDK defines no types of its own).
 */

export const AgentRegistrationResponse = z.object({
  agent_id: Id('agt'),
  /** Returned exactly once — never stored or retrievable again (CORE-3). */
  api_key: z.string().min(1),
});
export type AgentRegistrationResponse = z.infer<typeof AgentRegistrationResponse>;

/** `GET /v1/offers/:id` — a fresh single-offer quote every call. */
export const SingleOfferResponse = z.object({
  quote: OfferQuote,
  hint: z
    .object({ register_to_earn: z.literal(true), register_url: z.string() })
    .optional(),
});
export type SingleOfferResponse = z.infer<typeof SingleOfferResponse>;

/** `POST /v1/claims` — the single-funnel verdict (§3 codes verbatim). */
export const ClaimSubmitResponse = z.object({
  claim_id: Id('clm'),
  verdict: z.enum(['verified', 'rejected']),
  reason_code: RejectionReasonCode.optional(),
});
export type ClaimSubmitResponse = z.infer<typeof ClaimSubmitResponse>;

/** `GET /v1/claims/:id`. */
export const ClaimStatusResponse = z.object({
  claim_id: Id('clm'),
  status: z.enum(['pending', 'verified', 'rejected']),
  verdict: z.enum(['verified', 'rejected']).optional(),
  reason_code: RejectionReasonCode.optional(),
  /** Balanced settlement lines from the verdict (§10 step 6/B18) — present
   * once verified; the trio's ledger remains the source of truth. */
  entries_preview: EntrySet.optional(),
});
export type ClaimStatusResponse = z.infer<typeof ClaimStatusResponse>;
