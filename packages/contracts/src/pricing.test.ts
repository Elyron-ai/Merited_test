import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MECHANICS_FIXTURES } from './offer/mechanics/fixtures.js';
import type { OfferMechanics } from './offer/mechanics/index.js';
import { pence, type Money } from './money.js';
import { applyMechanics } from './pricing.js';

const gbp = (amount: number): Money => ({ amount, currency: 'GBP_pence' });

describe('applyMechanics (CORE-8 accept) — table-driven, one row per variant', () => {
  const table: Array<[OfferMechanics, number, number, string[]]> = [
    // [mechanics, list, expected final, expected labels]
    [{ type: 'percentage_off', pct_bps: 1500 }, 8450, 7183, ['percentage_off']], // floor(1267.5)
    [{ type: 'fixed_off', value: gbp(500) }, 8450, 7950, ['fixed_off']],
    [{ type: 'threshold_discount', min_spend: gbp(5000), value: gbp(750) }, 8450, 7700, ['threshold_discount']],
    [{ type: 'threshold_discount', min_spend: gbp(9000), value: gbp(750) }, 8450, 8450, []], // gate unmet
    [{ type: 'threshold_percentage', min_spend: gbp(5000), pct_bps: 1000 }, 8450, 7605, ['threshold_percentage']],
    [{ type: 'threshold_percentage', min_spend: gbp(9000), pct_bps: 1000 }, 8450, 8450, []],
    [{ type: 'bundle', sku_refs: ['a', 'b'], value: gbp(9900) }, 12000, 9900, ['bundle']],
    [{ type: 'bundle', sku_refs: ['a', 'b'], value: gbp(9900) }, 8450, 8450, ['bundle']], // never raises
    [{ type: 'bogo', buy_sku: 'a', get_sku: 'b', get_pct_bps: 10000 }, 8450, 8450, ['bogo']],
    [{ type: 'multibuy_price', sku_ref: 'a', qty: 3, total: gbp(2400) }, 8450, 8450, ['multibuy_price']],
    [{ type: 'member_price', sku_ref: 'a', price: gbp(6900) }, 8450, 6900, ['member_price']],
    [{ type: 'member_price', sku_ref: 'a', price: gbp(9900) }, 8450, 8450, ['member_price']], // clamp ≤ list
    [{ type: 'free_shipping', min_spend: gbp(3000) }, 8450, 8450, ['free_shipping']],
    [{ type: 'free_shipping', min_spend: gbp(9000) }, 8450, 8450, []],
    [{ type: 'free_shipping', min_spend: null }, 8450, 8450, ['free_shipping']],
    [{ type: 'free_gift', gift_sku: 'g', min_spend: gbp(6000) }, 8450, 8450, ['free_gift']],
    [{ type: 'free_gift', gift_sku: 'g', min_spend: gbp(9000) }, 8450, 8450, []],
    [{ type: 'points_multiplier', multiplier_x100: 200 }, 8450, 8450, ['points_multiplier']],
    [{ type: 'points_bonus', points: 500 }, 8450, 8450, ['points_bonus']],
    [{ type: 'points_threshold_bonus', min_spend: gbp(7500), points: 1000 }, 8450, 8450, ['points_threshold_bonus']],
    [{ type: 'points_per_sku', sku_ref: 'a', points: 250 }, 8450, 8450, ['points_per_sku']],
    [{ type: 'points_exchange_boost', rate_x100: 150 }, 8450, 8450, ['points_exchange_boost']],
    [{ type: 'points_back_pct', pct_bps: 500 }, 8450, 8450, ['points_back_pct']],
    [{ type: 'tier_unlock', tier: 'Gold' }, 8450, 8450, ['tier_unlock']],
    [{ type: 'tier_accelerator', tier: 'Gold', multiplier_x100: 150 }, 8450, 8450, ['tier_accelerator']],
    [{ type: 'tier_gift', tier: 'Gold', gift_sku: 'robe' }, 8450, 8450, ['tier_gift']],
    [{ type: 'welcome_bonus', value: gbp(1000) }, 8450, 7450, ['welcome_bonus']],
    [{ type: 'welcome_points', points: 750 }, 8450, 8450, ['welcome_points']],
    [{ type: 'winback', inactive_days: 90, value: gbp(1500) }, 8450, 6950, ['winback']],
    [{ type: 'referral_reward', referrer_points: 500, referee_value: gbp(1000) }, 8450, 7450, ['referral_reward']],
    [{ type: 'birthday_reward', value: gbp(2000) }, 8450, 6450, ['birthday_reward']],
    [{ type: 'early_access', window_s: 86400 }, 8450, 8450, ['early_access']],
    [{ type: 'experience_upgrade', from_sku: 'std', to_sku: 'suite' }, 8450, 8450, ['experience_upgrade']],
    [{ type: 'vip_event_invite', event_ref: 'evt-1' }, 8450, 8450, ['vip_event_invite']],
  ];

  it.each(table)('%o at list %ip', (mechanics, list, expectedFinal, expectedLabels) => {
    const result = applyMechanics(pence(list), mechanics);
    expect(result.final).toEqual(pence(expectedFinal));
    expect(result.mechanics_applied).toEqual(expectedLabels);
  });

  it('covers every union variant (27) at least once', () => {
    const covered = new Set(table.map(([m]) => m.type));
    for (const fixture of MECHANICS_FIXTURES) {
      expect(covered.has(fixture.type), `unpriced in table: ${fixture.type}`).toBe(true);
    }
    expect(covered.size).toBe(27);
  });

  it('rounding edges: 1p lists and odd bps always floor, never go negative', () => {
    expect(applyMechanics(pence(1), { type: 'percentage_off', pct_bps: 3333 }).final).toEqual(pence(1)); // floor(0.33) = 0 off
    expect(applyMechanics(pence(1), { type: 'percentage_off', pct_bps: 10000 }).final).toEqual(pence(0));
    expect(applyMechanics(pence(3), { type: 'percentage_off', pct_bps: 3333 }).final).toEqual(pence(3)); // floor(0.99)
    expect(applyMechanics(pence(0), { type: 'percentage_off', pct_bps: 9999 }).final).toEqual(pence(0));
    expect(applyMechanics(pence(499), { type: 'fixed_off', value: gbp(500) }).final).toEqual(pence(0)); // clamp
    expect(applyMechanics(pence(8450), { type: 'percentage_off', pct_bps: 1 }).final).toEqual(pence(8450)); // floor(0.845)
  });

  it('property: 0 ≤ final ≤ list for EVERY variant, and currency is always GBP_pence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom(...MECHANICS_FIXTURES),
        (list, mechanics) => {
          const { final, mechanics_applied } = applyMechanics(pence(list), mechanics);
          expect(final.amount).toBeGreaterThanOrEqual(0);
          expect(final.amount).toBeLessThanOrEqual(list);
          expect(Number.isInteger(final.amount)).toBe(true);
          expect(final.currency).toBe('GBP_pence');
          expect(mechanics_applied.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
