import { z } from 'zod';
import { GuardrailSettings } from './pipeline.js';
import { Id } from './ids.js';
import { Money } from './money.js';

/**
 * Merchant record (MER-1, §5.7). `commercial` is the config CORE-5 folds
 * into commitment drafts (take-rate, commission split, windows — SYN-12
 * budgets are optional Settlement counters). `signing_key_ref` is a KEY
 * REFERENCE only: private material lives behind KMS/FakeSigner custody and
 * never appears in any schema (SYN-22/32).
 */
export const MerchantCommercial = z.object({
  take_rate_bps: z.number().int().nonnegative(),
  agent_commission_bps: z.number().int().nonnegative(),
  attribution_window_s: z.number().int().positive(),
  clawback_window_s: z.number().int().nonnegative(),
  budgets: z.object({
    per_offer_default: Money.nullable(),
  }),
  /** PH2-1 (§5.6): per-merchant guardrail config; absent = all rules inert. */
  guardrails: GuardrailSettings.nullable().optional(),
});
export type MerchantCommercial = z.infer<typeof MerchantCommercial>;

export const Merchant = z.object({
  merchant_id: Id('mer'),
  name: z.string().min(1),
  /** URL-safe routing handle (MER-3's `:merchant_slug` webhook path). */
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  status: z.enum(['active', 'suspended']),
  commercial: MerchantCommercial,
  /** Custodied key reference — null until MER-2's keypair issuance runs. */
  signing_key_ref: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type Merchant = z.infer<typeof Merchant>;
