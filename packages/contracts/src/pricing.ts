import { Money, pence } from './money.js';
import type { OfferMechanics } from './offer/mechanics/index.js';

/**
 * `applyMechanics` — the ONE pricing function (CORE-8, B24/§5.6a). Lives in
 * contracts because the wallet UI must share it for display parity (SYN-13).
 *
 * Rules (§5.6a + SYN-38):
 *  - integer-pence arithmetic only; percentage discounts floor.
 *  - `fixed_off`-style discounts clamp the final price at 0.
 *  - price-setters (`bundle`, `member_price`) clamp at the list price —
 *    a mechanic never RAISES the quoted price.
 *  - threshold-gated mechanics apply only when `list ≥ min_spend`; an
 *    unapplied mechanic leaves the price unchanged and adds no label.
 *  - points-denominated, basket-dependent (bogo/multibuy/shipping/gift),
 *    tier and access mechanics are PRICE-NEUTRAL at quote time: the price
 *    is unchanged, the label is appended (the benefit is conveyed, not
 *    priced — baskets do not exist on the read path).
 *  - exhaustive switch: a 28th variant fails compilation until priced.
 */
export interface AppliedPricing {
  final: Money;
  mechanics_applied: string[];
}

const assertNever = (variant: never): never => {
  throw new Error(`unpriced mechanics variant: ${JSON.stringify(variant)}`);
};

const floorBps = (amountPence: number, bps: number): number =>
  Math.floor((amountPence * bps) / 10000);

export const applyMechanics = (list: Money, mechanics: OfferMechanics): AppliedPricing => {
  const listPence = Money.parse(list).amount;
  const priced = (finalPence: number, applied: boolean): AppliedPricing => ({
    final: pence(Math.min(listPence, Math.max(0, finalPence))),
    mechanics_applied: applied ? [mechanics.type] : [],
  });
  const neutral = (): AppliedPricing => priced(listPence, true);

  switch (mechanics.type) {
    // ── price family ────────────────────────────────────────────────────────
    case 'percentage_off':
      return priced(listPence - floorBps(listPence, mechanics.pct_bps), true);
    case 'fixed_off':
      return priced(listPence - mechanics.value.amount, true);
    case 'threshold_discount':
      return listPence >= mechanics.min_spend.amount
        ? priced(listPence - mechanics.value.amount, true)
        : priced(listPence, false);
    case 'threshold_percentage':
      return listPence >= mechanics.min_spend.amount
        ? priced(listPence - floorBps(listPence, mechanics.pct_bps), true)
        : priced(listPence, false);
    case 'bundle':
      return priced(mechanics.value.amount, true); // price-setter, clamped ≤ list
    case 'member_price':
      return priced(mechanics.price.amount, true); // price-setter, clamped ≤ list
    case 'bogo':
    case 'multibuy_price':
      return neutral(); // basket-dependent — priced at checkout, not at quote
    case 'free_shipping':
      return mechanics.min_spend === null || listPence >= mechanics.min_spend.amount
        ? neutral()
        : priced(listPence, false);
    case 'free_gift':
      return listPence >= mechanics.min_spend.amount ? neutral() : priced(listPence, false);

    // ── points family: price unchanged, label appended (§5.6a) ─────────────
    case 'points_multiplier':
    case 'points_bonus':
    case 'points_threshold_bonus':
    case 'points_per_sku':
    case 'points_exchange_boost':
    case 'points_back_pct':
      return neutral();

    // ── tier/status family: non-price benefits ─────────────────────────────
    case 'tier_unlock':
    case 'tier_accelerator':
    case 'tier_gift':
      return neutral();

    // ── lifecycle family: money-denominated rewards discount; points don't ──
    case 'welcome_bonus':
      return priced(listPence - mechanics.value.amount, true);
    case 'winback':
      return priced(listPence - mechanics.value.amount, true);
    case 'birthday_reward':
      return priced(listPence - mechanics.value.amount, true);
    case 'referral_reward':
      return priced(listPence - mechanics.referee_value.amount, true);
    case 'welcome_points':
      return neutral();

    // ── access family: non-price benefits ──────────────────────────────────
    case 'early_access':
    case 'experience_upgrade':
    case 'vip_event_invite':
      return neutral();

    default:
      return assertNever(mechanics);
  }
};
