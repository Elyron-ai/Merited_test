import type { OfferMechanics } from './index.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

/**
 * One golden fixture per variant (FND-5 accept). Lives beside the union in
 * src/ (rather than the plan's test/fixtures/ path) so tsc project builds
 * stay rooted at src — deviation recorded in the build log.
 */
export const MECHANICS_FIXTURES: readonly OfferMechanics[] = [
  // Price (10)
  { type: 'percentage_off', pct_bps: 1500 },
  { type: 'fixed_off', value: gbp(500) },
  { type: 'threshold_discount', min_spend: gbp(5000), value: gbp(750) },
  { type: 'threshold_percentage', min_spend: gbp(10000), pct_bps: 1000 },
  { type: 'bundle', sku_refs: ['sku_spa_day', 'sku_lunch'], value: gbp(9900) },
  { type: 'bogo', buy_sku: 'sku_massage', get_sku: 'sku_sauna', get_pct_bps: 10000 },
  { type: 'multibuy_price', sku_ref: 'sku_yoga_class', qty: 3, total: gbp(2400) },
  { type: 'member_price', sku_ref: 'sku_spa_day', price: gbp(8450) },
  { type: 'free_shipping', min_spend: gbp(3000) },
  { type: 'free_gift', gift_sku: 'sku_candle', min_spend: gbp(6000) },
  // Points (6)
  { type: 'points_multiplier', multiplier_x100: 200 },
  { type: 'points_bonus', points: 500 },
  { type: 'points_threshold_bonus', min_spend: gbp(7500), points: 1000 },
  { type: 'points_per_sku', sku_ref: 'sku_spa_day', points: 250 },
  { type: 'points_exchange_boost', rate_x100: 150 },
  { type: 'points_back_pct', pct_bps: 500 },
  // Tier/status (3)
  { type: 'tier_unlock', tier: 'Gold' },
  { type: 'tier_accelerator', tier: 'Gold', multiplier_x100: 150 },
  { type: 'tier_gift', tier: 'Gold', gift_sku: 'sku_robe' },
  // Lifecycle (5)
  { type: 'welcome_bonus', value: gbp(1000) },
  { type: 'welcome_points', points: 750 },
  { type: 'winback', inactive_days: 90, value: gbp(1500) },
  { type: 'referral_reward', referrer_points: 500, referee_value: gbp(1000) },
  { type: 'birthday_reward', value: gbp(2000) },
  // Access (3)
  { type: 'early_access', window_s: 86400 },
  { type: 'experience_upgrade', from_sku: 'sku_standard_room', to_sku: 'sku_suite' },
  { type: 'vip_event_invite', event_ref: 'evt-aurora-launch-night' },
];
