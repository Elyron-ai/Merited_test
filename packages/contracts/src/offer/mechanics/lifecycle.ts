import { z } from 'zod';
import { Money } from '../../money.js';

/** Lifecycle-family mechanics (5 of 27) — FND D10. ★ = spec-named variant. */

export const WelcomeBonus = z.object({
  type: z.literal('welcome_bonus'), // ★
  value: Money,
});

export const WelcomePoints = z.object({
  type: z.literal('welcome_points'),
  points: z.number().int().positive(),
});

export const Winback = z.object({
  type: z.literal('winback'),
  inactive_days: z.number().int().positive(),
  value: Money,
});

export const ReferralReward = z.object({
  type: z.literal('referral_reward'),
  referrer_points: z.number().int().positive(),
  referee_value: Money,
});

export const BirthdayReward = z.object({
  type: z.literal('birthday_reward'),
  value: Money,
});

export const LIFECYCLE_MECHANICS = [
  WelcomeBonus,
  WelcomePoints,
  Winback,
  ReferralReward,
  BirthdayReward,
] as const;
