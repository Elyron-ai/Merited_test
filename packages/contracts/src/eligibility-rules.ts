import { z } from 'zod';
import { Id } from './ids.js';

/**
 * Eligibility rule config (PH1-1 → PH1-3, §5.4). The filter CHAIN is fixed
 * by the spec (liveness → tier → commitment+cap → stacking → merchant
 * exclusions); only the merchant-exclusion stage is data-driven, so that is
 * the one rule variant today. A discriminated union so future configurable
 * stages append as new variants (contracts-first), never as schema edits.
 */

/** A merchant excluding a specific agent from its offers (§5.4, Phase 1). */
export const MerchantExclusion = z.object({
  merchant_id: Id('mer'),
  agent_id: Id('agt'),
  note: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type MerchantExclusion = z.infer<typeof MerchantExclusion>;

export const EligibilityRule = z.discriminatedUnion('type', [
  MerchantExclusion.extend({ type: z.literal('merchant_agent_exclusion') }),
]);
export type EligibilityRule = z.infer<typeof EligibilityRule>;
