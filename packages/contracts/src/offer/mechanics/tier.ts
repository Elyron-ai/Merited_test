import { z } from 'zod';

/** Tier/status-family mechanics (3 of 27) — FND D10. ★ = spec-named variant. */

export const TierUnlock = z.object({
  type: z.literal('tier_unlock'), // ★
  tier: z.string(),
});

export const TierAccelerator = z.object({
  type: z.literal('tier_accelerator'),
  tier: z.string(),
  multiplier_x100: z.number().int().positive(),
});

export const TierGift = z.object({
  type: z.literal('tier_gift'),
  tier: z.string(),
  gift_sku: z.string(),
});

export const TIER_MECHANICS = [TierUnlock, TierAccelerator, TierGift] as const;
