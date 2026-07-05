import { z } from 'zod';
import { Id } from './ids.js';
import { IdentityTier } from './tier.js';
import { Segment } from './segment.js';

/**
 * Eligibility rule config (PH1-1/PH1-3, §5.4). The filter CHAIN is fixed by
 * the spec (liveness → tier → commitment+cap → stacking → merchant
 * exclusions); the merchant-exclusion stage is the data-driven one. A
 * discriminated union so future configurable stages append as new variants
 * (contracts-first), never as schema edits. `rule_id` is a plain opaque id
 * (rules are config rows, not ledger entities — no SYN-4 prefix).
 */
const ruleBase = {
  rule_id: z.string().min(1),
  merchant_id: Id('mer'),
  note: z.string().nullable(),
  created_at: z.string().datetime(),
};

/** A merchant excluding a specific agent from its offers. */
export const MerchantExclusion = z.object({
  ...ruleBase,
  type: z.literal('merchant_agent_exclusion'),
  agent_id: Id('agt'),
});
export type MerchantExclusion = z.infer<typeof MerchantExclusion>;

/** A merchant excluding an identity tier or segment (e.g. no acquisition
 * bounties on anonymous traffic). */
export const MerchantTierExclusion = z.object({
  ...ruleBase,
  type: z.literal('merchant_tier_exclusion'),
  tier: IdentityTier.nullable(),
  segment: Segment.nullable(),
});
export type MerchantTierExclusion = z.infer<typeof MerchantTierExclusion>;

/** A merchant excluding a SKU/category from agent distribution. */
export const MerchantSkuExclusion = z.object({
  ...ruleBase,
  type: z.literal('merchant_sku_exclusion'),
  sku_ref: z.string().min(1),
});
export type MerchantSkuExclusion = z.infer<typeof MerchantSkuExclusion>;

export const EligibilityRule = z.discriminatedUnion('type', [
  MerchantExclusion,
  MerchantTierExclusion,
  MerchantSkuExclusion,
]);
export type EligibilityRule = z.infer<typeof EligibilityRule>;
