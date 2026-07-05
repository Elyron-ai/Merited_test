import { z } from 'zod';
import { AgentCtx } from './ctx.js';
import { Id } from './ids.js';
import { Offer } from './offer/offer.js';
import { OfferQuote } from './quote.js';
import { RejectionReasonCode } from './reasons.js';
import { Segment } from './segment.js';
import { IdentityTier } from './tier.js';

/**
 * Read-path pipeline shapes (CORE-6/7, §4/§5.4/§5.5). The pipeline has its
 * final shape in Phase 0 — B7 (RulesDecisioner, Ph1) and B8 (real
 * guardrails, Ph2) are file swaps behind these interfaces (P4).
 */

/** An offer that survived eligibility, carrying its live COR reference. */
export const EligibleOffer = z.object({
  offer: Offer,
  commitment_id: Id('com').nullable(),
});
export type EligibleOffer = z.infer<typeof EligibleOffer>;

/** Ranked = ordered; `score` is decisioner-internal colour (optional). */
export const RankedOffer = EligibleOffer.extend({
  score: z.number().optional(),
});
export type RankedOffer = z.infer<typeof RankedOffer>;

/**
 * Eligibility exclusions reuse §3's first-class reason codes; the two
 * read-path-only conditions get their own literals (SYN-37) — the VERIFY
 * rejection enum stays closed (SYN-10).
 */
export const EligibilityExclusionReason = z.union([
  RejectionReasonCode,
  z.literal('OFFER_NOT_LIVE'),
  z.literal('STACKING_DEDUPED'),
  z.literal('MERCHANT_EXCLUDED'), // §5.4 merchant-exclusion stage (PH1-3)
]);
export type EligibilityExclusionReason = z.infer<typeof EligibilityExclusionReason>;

export const EligibilityExclusion = z.object({
  offer_id: Id('off'),
  reason: EligibilityExclusionReason,
});
export type EligibilityExclusion = z.infer<typeof EligibilityExclusion>;

export const EligibilityResult = z.object({
  eligible: z.array(EligibleOffer),
  excluded: z.array(EligibilityExclusion),
});
export type EligibilityResult = z.infer<typeof EligibilityResult>;

export const DecisionCtx = z.object({
  agent: AgentCtx,
  tier: IdentityTier,
  segment: Segment,
});
export type DecisionCtx = z.infer<typeof DecisionCtx>;

export const GuardrailCtx = DecisionCtx;
export type GuardrailCtx = z.infer<typeof GuardrailCtx>;

/**
 * Per-merchant guardrail configuration (PH2-1, §5.6) — rides the merchant's
 * commercial config (B13). Every field optional: an unconfigured guardrail
 * is inert (all offers pass), so enabling rules is data, never a deploy.
 */
export const GuardrailSettings = z.object({
  /** Maximum price give-away, basis points of list ((list−final)/list). */
  margin_ceiling_bps: z.number().int().nonnegative().nullable().optional(),
  /** Brand denylist: category slugs and title/description terms. */
  denylist: z
    .object({ categories: z.array(z.string()), terms: z.array(z.string()) })
    .nullable()
    .optional(),
  /** Budget pacing: λ_bps = 10000·(remaining/reference)÷time_remaining_fraction.
   * Below the threshold, points-denominated mechanics re-rank first (points
   * are the cheapest currency — §5.6). */
  pacing: z
    .object({
      reference_budget_pence: z.number().int().positive(),
      lambda_threshold_bps: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type GuardrailSettings = z.infer<typeof GuardrailSettings>;

/** Read-path facts the guardrails need beyond the DecisionCtx (PH2-1):
 * live commitment counters keyed by commitment id, per-merchant settings,
 * and the read's clock. Supplied by the pipeline host; optional so the
 * Phase-0 Noop implementation's call sites stay valid. */
export interface GuardrailInputs {
  now: Date;
  statuses: Record<string, { budget_remaining: { amount: number; currency: 'GBP_pence' } | null; conversions_used: number; max_conversions: number | null } | null>;
  settings: Record<string, GuardrailSettings | null>;
}

/**
 * `readOffers()` response (CORE-11, §4/B4): anonymous reads get quotes with
 * `token: null` plus the register_to_earn hint — visible but not payable is
 * the adoption incentive (arch §2.3, P2).
 */
export const OfferReadResponse = z.object({
  quotes: z.array(OfferQuote),
  hint: z
    .object({
      register_to_earn: z.literal(true),
      register_url: z.string(),
    })
    .optional(),
});
export type OfferReadResponse = z.infer<typeof OfferReadResponse>;

/** `GET /v1/quotes/:id` (CORE-12): derived status + the persisted promise. */
export const QuoteStatusResponse = z.object({
  status: z.enum(['live', 'expired', 'converted']),
  quote: z.object({
    quote_id: Id('qte'),
    offer_id: Id('off'),
    commitment_id: Id('com'),
    price: z.object({ list: z.object({ amount: z.number().int(), currency: z.literal('GBP_pence') }), final: z.object({ amount: z.number().int(), currency: z.literal('GBP_pence') }) }),
    expires_at: z.string().datetime(),
  }),
});
export type QuoteStatusResponse = z.infer<typeof QuoteStatusResponse>;

/** §5.5 verbatim: the decisioning slot. Ph0 production = Passthrough. */
export interface Decisioner {
  rank(eligible: EligibleOffer[], ctx: DecisionCtx): Promise<RankedOffer[]>;
}

export interface Guardrails {
  apply(
    ranked: RankedOffer[],
    ctx: GuardrailCtx,
    inputs?: GuardrailInputs,
  ): { passed: RankedOffer[]; suppressed: Array<{ offer_id: string; reason: string }> };
}
