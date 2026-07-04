import { z } from 'zod';
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
});
export type MerchantCommercial = z.infer<typeof MerchantCommercial>;

export const Merchant = z.object({
  merchant_id: Id('mer'),
  name: z.string().min(1),
  status: z.enum(['active', 'suspended']),
  commercial: MerchantCommercial,
  signing_key_ref: z.string(),
  created_at: z.string().datetime(),
});
export type Merchant = z.infer<typeof Merchant>;
