import { z } from 'zod';
import { Id } from './ids.js';
import { EligibilityExclusionReason, OfferReadResponse } from './pipeline.js';
import { SingleOfferResponse } from './api.js';

/**
 * MCP tool I/O schemas (PH1-1 → PH1-6, B10). The MCP server is protocol,
 * not adapter (§2.2) — these are the tool input/output shapes it validates
 * against; the underlying behaviour is the SAME read path as REST (B9).
 * SYN-26: `check_eligibility` mints NO tokens — verdicts + exclusion
 * reasons only; `search_offers`/`get_offer` return tokenised quotes.
 */

/** Consumer identity signals as they arrive over the wire (§4). */
const consumerSignals = {
  consumer_ref: z.string().optional(),
  sub_hash: z.string().optional(),
  member_ref: z.string().optional(),
  hashed_email: z.string().optional(),
};

export const SearchOffersInput = z.object({
  text: z.string().max(200).optional(),
  merchant_id: z.string().optional(),
  sku: z.string().optional(),
  ...consumerSignals,
});
export type SearchOffersInput = z.infer<typeof SearchOffersInput>;

/** Same shape as the REST read (B9 wraps everything). */
export const SearchOffersOutput = OfferReadResponse;
export type SearchOffersOutput = z.infer<typeof SearchOffersOutput>;

export const GetOfferInput = z.object({
  offer_id: Id('off'),
  ...consumerSignals,
});
export type GetOfferInput = z.infer<typeof GetOfferInput>;

export const GetOfferOutput = SingleOfferResponse;
export type GetOfferOutput = z.infer<typeof GetOfferOutput>;

export const CheckEligibilityInput = z.object({
  offer_ids: z.array(Id('off')).min(1).max(50),
  ...consumerSignals,
});
export type CheckEligibilityInput = z.infer<typeof CheckEligibilityInput>;

/** Verdicts only — deliberately quote-free and token-free (SYN-26). */
export const CheckEligibilityOutput = z.object({
  results: z.array(
    z.object({
      offer_id: Id('off'),
      eligible: z.boolean(),
      reason: EligibilityExclusionReason.optional(),
    }),
  ),
});
export type CheckEligibilityOutput = z.infer<typeof CheckEligibilityOutput>;
