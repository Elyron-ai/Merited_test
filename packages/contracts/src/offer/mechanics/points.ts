import { z } from 'zod';
import { Money } from '../../money.js';

/** Points-family mechanics (6 of 27) — FND D10. ★ = spec-named variant. */

export const PointsMultiplier = z.object({
  type: z.literal('points_multiplier'), // ★
  multiplier_x100: z.number().int().positive(),
});

export const PointsBonus = z.object({
  type: z.literal('points_bonus'), // ★
  points: z.number().int().positive(),
});

export const PointsThresholdBonus = z.object({
  type: z.literal('points_threshold_bonus'),
  min_spend: Money,
  points: z.number().int().positive(),
});

export const PointsPerSku = z.object({
  type: z.literal('points_per_sku'),
  sku_ref: z.string(),
  points: z.number().int().positive(),
});

export const PointsExchangeBoost = z.object({
  type: z.literal('points_exchange_boost'),
  rate_x100: z.number().int().positive(),
});

export const PointsBackPct = z.object({
  type: z.literal('points_back_pct'),
  pct_bps: z.number().int().positive(),
});

export const POINTS_MECHANICS = [
  PointsMultiplier,
  PointsBonus,
  PointsThresholdBonus,
  PointsPerSku,
  PointsExchangeBoost,
  PointsBackPct,
] as const;
