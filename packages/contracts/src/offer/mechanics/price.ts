import { z } from 'zod';
import { Money } from '../../money.js';

/** Price-family mechanics (10 of 27) — FND D10. ★ = spec-named variant. */

export const PercentageOff = z.object({
  type: z.literal('percentage_off'), // ★
  pct_bps: z.number().int().positive(),
});

export const FixedOff = z.object({
  type: z.literal('fixed_off'), // ★
  value: Money,
});

export const ThresholdDiscount = z.object({
  type: z.literal('threshold_discount'),
  min_spend: Money,
  value: Money,
});

export const ThresholdPercentage = z.object({
  type: z.literal('threshold_percentage'),
  min_spend: Money,
  pct_bps: z.number().int().positive(),
});

export const Bundle = z.object({
  type: z.literal('bundle'), // ★
  sku_refs: z.array(z.string()).min(1),
  value: Money,
});

export const Bogo = z.object({
  type: z.literal('bogo'),
  buy_sku: z.string(),
  get_sku: z.string(),
  get_pct_bps: z.number().int().positive(),
});

export const MultibuyPrice = z.object({
  type: z.literal('multibuy_price'),
  sku_ref: z.string(),
  qty: z.number().int().min(2),
  total: Money,
});

export const MemberPrice = z.object({
  type: z.literal('member_price'),
  sku_ref: z.string(),
  price: Money,
});

export const FreeShipping = z.object({
  type: z.literal('free_shipping'),
  min_spend: Money.nullable(),
});

export const FreeGift = z.object({
  type: z.literal('free_gift'),
  gift_sku: z.string(),
  min_spend: Money,
});

export const PRICE_MECHANICS = [
  PercentageOff,
  FixedOff,
  ThresholdDiscount,
  ThresholdPercentage,
  Bundle,
  Bogo,
  MultibuyPrice,
  MemberPrice,
  FreeShipping,
  FreeGift,
] as const;
