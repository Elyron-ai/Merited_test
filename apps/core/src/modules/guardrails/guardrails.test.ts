import {
  newId,
  pence,
  type GuardrailInputs,
  type GuardrailSettings,
  type Offer,
  type OfferMechanics,
  type RankedOffer,
} from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyGuardrails,
  isPointsDenominated,
  lambdaBps,
  marginCostBps,
  RuleGuardrails,
} from './index.js';

/**
 * PH2-1 unit suite — the B8 rules are PURE functions of (ranked list,
 * settings, counters, clock), so every behaviour here is deterministic:
 * same fixtures, same verdicts, every run.
 */

const NOW = new Date('2026-07-05T12:00:00Z');
const FROM = '2026-07-01T00:00:00Z';
const UNTIL = '2026-07-09T00:00:00Z'; // 8-day window; at NOW, 3.5d remain → 0.4375

const mkOffer = (overrides: Partial<Offer> = {}): Offer => ({
  offer_id: newId('off'),
  merchant_id: newId('mer'),
  title: 'Spa day',
  description: 'A relaxing spa day at Aurora',
  mechanics: { type: 'percentage_off', pct_bps: 1500 },
  sku_scope: 'all',
  identity_tiers: ['T1', 'T2', 'T3'],
  stacking_group: null,
  status: 'live',
  valid_from: FROM,
  valid_until: UNTIL,
  ...overrides,
});

const mkRanked = (offer: Offer, commitmentId: string | null = null): RankedOffer => ({
  offer,
  commitment_id: (commitmentId ?? newId('com')) as `com_${string}`,
});

const okStatus = (remaining: number | null) => ({
  budget_remaining: remaining === null ? null : pence(remaining),
  conversions_used: 0,
  max_conversions: null,
});

const inputs = (overrides: Partial<GuardrailInputs> = {}): GuardrailInputs => ({
  now: NOW,
  statuses: {},
  settings: {},
  ...overrides,
});

const listPriceFor = () => pence(10000);

describe('guardrail primitives', () => {
  it('isPointsDenominated: exactly the points_* mechanics family', () => {
    expect(isPointsDenominated({ type: 'points_bonus', points: 500 })).toBe(true);
    expect(isPointsDenominated({ type: 'points_multiplier', multiplier_x100: 200 })).toBe(true);
    expect(isPointsDenominated({ type: 'percentage_off', pct_bps: 1500 })).toBe(false);
    expect(isPointsDenominated({ type: 'fixed_off', value: pence(500) })).toBe(false);
  });

  it('marginCostBps: (list − final)/list in bps; points mechanics cost 0 (price unchanged)', () => {
    const list = pence(10000);
    expect(marginCostBps(list, { type: 'percentage_off', pct_bps: 1500 })).toBe(1500);
    expect(marginCostBps(list, { type: 'fixed_off', value: pence(2500) })).toBe(2500);
    expect(marginCostBps(list, { type: 'points_bonus', points: 500 })).toBe(0);
    expect(marginCostBps(list, { type: 'points_multiplier', multiplier_x100: 300 })).toBe(0);
    expect(marginCostBps(pence(0), { type: 'percentage_off', pct_bps: 1500 })).toBe(0);
  });

  it('lambdaBps: 10000·(remaining/reference)÷time_remaining_fraction, floored', () => {
    // half the budget left, 43.75% of the window left → running slightly hot
    expect(
      lambdaBps({
        budgetRemaining: pence(5000),
        referenceBudgetPence: 10000,
        validFrom: FROM,
        validUntil: UNTIL,
        now: NOW,
      }),
    ).toBe(Math.floor((10000 * 0.5) / 0.4375)); // 11428 — on-pace-ish
    // 10% budget, 43.75% time → burning far too fast
    expect(
      lambdaBps({
        budgetRemaining: pence(1000),
        referenceBudgetPence: 10000,
        validFrom: FROM,
        validUntil: UNTIL,
        now: NOW,
      }),
    ).toBe(2285);
  });

  it('lambdaBps: null without a budget counter; time fraction clamped to [0.01, 1]', () => {
    expect(
      lambdaBps({
        budgetRemaining: null,
        referenceBudgetPence: 10000,
        validFrom: FROM,
        validUntil: UNTIL,
        now: NOW,
      }),
    ).toBeNull();
    // an already-expired window clamps at 0.01, never divides by ≤ 0
    expect(
      lambdaBps({
        budgetRemaining: pence(1),
        referenceBudgetPence: 10000,
        validFrom: FROM,
        validUntil: '2026-07-04T00:00:00Z',
        now: NOW,
      }),
    ).toBe(100); // 10000·0.0001 ÷ 0.01
    // an inverted window (until ≤ from) has no pace to measure
    expect(
      lambdaBps({
        budgetRemaining: pence(1),
        referenceBudgetPence: 10000,
        validFrom: UNTIL,
        validUntil: FROM,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe('applyGuardrails (PH2-1 accept: deterministic rules over ranked offers)', () => {
  it('unconfigured merchants pass everything untouched — enabling a rule is data, not a deploy', () => {
    const ranked = [mkRanked(mkOffer()), mkRanked(mkOffer())];
    const verdict = applyGuardrails(ranked, inputs(), listPriceFor);
    expect(verdict.passed).toEqual(ranked);
    expect(verdict.suppressed).toEqual([]);
  });

  it('RuleGuardrails without inputs is a passthrough (Phase-0 call sites stay valid)', () => {
    const ranked = [mkRanked(mkOffer())];
    const verdict = new RuleGuardrails(listPriceFor).apply(ranked, {
      agent: { agent_id: null },
      tier: 'T3',
      segment: 't3-acquisition',
    });
    expect(verdict).toEqual({ passed: ranked, suppressed: [] });
  });

  it('brand denylist: term match on title/description is case-insensitive', () => {
    const offer = mkOffer({ title: 'CLEARANCE spa day' });
    const settings: GuardrailSettings = { denylist: { categories: [], terms: ['clearance'] } };
    const verdict = applyGuardrails(
      [mkRanked(offer)],
      inputs({ settings: { [offer.merchant_id]: settings } }),
      listPriceFor,
    );
    expect(verdict.passed).toEqual([]);
    expect(verdict.suppressed).toEqual([
      { offer_id: offer.offer_id, reason: 'BRAND_DENYLIST' },
    ]);
  });

  it('brand denylist: category match against an sku_scope list; scope "all" is untouched by categories', () => {
    const merchantId = newId('mer');
    const scoped = mkOffer({ merchant_id: merchantId, sku_scope: ['sku_gift_cards'] });
    const allScope = mkOffer({ merchant_id: merchantId, sku_scope: 'all' });
    const settings: GuardrailSettings = {
      denylist: { categories: ['sku_gift_cards'], terms: [] },
    };
    const verdict = applyGuardrails(
      [mkRanked(scoped), mkRanked(allScope)],
      inputs({ settings: { [merchantId]: settings } }),
      listPriceFor,
    );
    expect(verdict.suppressed).toEqual([
      { offer_id: scoped.offer_id, reason: 'BRAND_DENYLIST' },
    ]);
    expect(verdict.passed.map((c) => c.offer.offer_id)).toEqual([allScope.offer_id]);
  });

  it('ACCEPT: margin-floor breach excludes the offer with the reason surfaced', () => {
    const merchantId = newId('mer');
    // 25% off list = 2500 bps cost against a 2000 bps ceiling → breach
    const breach = mkOffer({
      merchant_id: merchantId,
      mechanics: { type: 'percentage_off', pct_bps: 2500 },
    });
    // exactly at the ceiling passes (the rule is strictly greater-than)
    const atCeiling = mkOffer({
      merchant_id: merchantId,
      mechanics: { type: 'percentage_off', pct_bps: 2000 },
    });
    const verdict = applyGuardrails(
      [mkRanked(breach), mkRanked(atCeiling)],
      inputs({ settings: { [merchantId]: { margin_ceiling_bps: 2000 } } }),
      listPriceFor,
    );
    expect(verdict.suppressed).toEqual([
      { offer_id: breach.offer_id, reason: 'MARGIN_CEILING_EXCEEDED' },
    ]);
    expect(verdict.passed.map((c) => c.offer.offer_id)).toEqual([atCeiling.offer_id]);
  });

  it('points mechanics never breach a margin ceiling — the price is unchanged', () => {
    const merchantId = newId('mer');
    const points = mkOffer({
      merchant_id: merchantId,
      mechanics: { type: 'points_multiplier', multiplier_x100: 300 },
    });
    const verdict = applyGuardrails(
      [mkRanked(points)],
      inputs({ settings: { [merchantId]: { margin_ceiling_bps: 0 } } }),
      listPriceFor,
    );
    expect(verdict.passed).toHaveLength(1);
    expect(verdict.suppressed).toEqual([]);
  });

  it('budget_remaining ≤ 0 suppresses with BUDGET_EXHAUSTED even for an UNCONFIGURED merchant (§5.6 baseline)', () => {
    // no settings entry for this merchant at all — the budget rule is
    // platform integrity, never merchant opt-in
    const offer = mkOffer();
    const cid = newId('com');
    const verdict = applyGuardrails(
      [mkRanked(offer, cid)],
      inputs({ statuses: { [cid]: okStatus(0) } }),
      listPriceFor,
    );
    expect(verdict.passed).toEqual([]);
    expect(verdict.suppressed).toEqual([
      { offer_id: offer.offer_id, reason: 'BUDGET_EXHAUSTED' },
    ]);
  });

  it('a null budget_remaining (uncapped) never trips the budget rule', () => {
    const offer = mkOffer();
    const cid = newId('com');
    const verdict = applyGuardrails(
      [mkRanked(offer, cid)],
      inputs({ statuses: { [cid]: okStatus(null) } }),
      listPriceFor,
    );
    expect(verdict.passed).toHaveLength(1);
    expect(verdict.suppressed).toEqual([]);
  });

  it('ACCEPT: λ below threshold deterministically re-ranks points mechanics first (stable within groups)', () => {
    const merchantId = newId('mer');
    const cid = newId('com');
    const at = (mechanics: OfferMechanics, title: string) =>
      mkRanked(mkOffer({ merchant_id: merchantId, mechanics, title }), cid);
    const pricedA = at({ type: 'percentage_off', pct_bps: 1000 }, 'Priced A');
    const pointsA = at({ type: 'points_bonus', points: 500 }, 'Points A');
    const pricedB = at({ type: 'fixed_off', value: pence(500) }, 'Priced B');
    const pointsB = at({ type: 'points_multiplier', multiplier_x100: 200 }, 'Points B');
    // 10% budget left with 43.75% of the window left → λ = 2285 < 5000
    const guardrailInputs = inputs({
      statuses: { [cid]: okStatus(1000) },
      settings: {
        [merchantId]: {
          pacing: { reference_budget_pence: 10000, lambda_threshold_bps: 5000 },
        },
      },
    });
    const ranked = [pricedA, pointsA, pricedB, pointsB];
    const verdict = applyGuardrails(ranked, guardrailInputs, listPriceFor);
    expect(verdict.suppressed).toEqual([]); // pacing re-ranks, never suppresses
    expect(verdict.passed.map((c) => c.offer.title)).toEqual([
      'Points A', // points group, original order preserved…
      'Points B',
      'Priced A', // …then priced group, original order preserved
      'Priced B',
    ]);
    // deterministic: same inputs, same order, every run
    expect(applyGuardrails(ranked, guardrailInputs, listPriceFor).passed).toEqual(
      verdict.passed,
    );
  });

  it('λ re-rank scopes to the low-λ merchant only; a healthy merchant keeps its order', () => {
    const hot = newId('mer');
    const healthy = newId('mer');
    const hotCid = newId('com');
    const healthyCid = newId('com');
    const hotPriced = mkRanked(
      mkOffer({ merchant_id: hot, mechanics: { type: 'percentage_off', pct_bps: 1000 }, title: 'Hot priced' }),
      hotCid,
    );
    const healthyPriced = mkRanked(
      mkOffer({ merchant_id: healthy, mechanics: { type: 'percentage_off', pct_bps: 1000 }, title: 'Healthy priced' }),
      healthyCid,
    );
    const healthyPoints = mkRanked(
      mkOffer({ merchant_id: healthy, mechanics: { type: 'points_bonus', points: 100 }, title: 'Healthy points' }),
      healthyCid,
    );
    const hotPoints = mkRanked(
      mkOffer({ merchant_id: hot, mechanics: { type: 'points_bonus', points: 100 }, title: 'Hot points' }),
      hotCid,
    );
    const pacing = { reference_budget_pence: 10000, lambda_threshold_bps: 5000 };
    const verdict = applyGuardrails(
      [hotPriced, healthyPriced, healthyPoints, hotPoints],
      inputs({
        // hot: λ 2285 (below threshold); healthy: λ 20571 (comfortably above)
        statuses: { [hotCid]: okStatus(1000), [healthyCid]: okStatus(9000) },
        settings: { [hot]: { pacing }, [healthy]: { pacing } },
      }),
      listPriceFor,
    );
    expect(verdict.passed.map((c) => c.offer.title)).toEqual([
      'Hot points', // only the hot merchant's points jump the queue
      'Hot priced',
      'Healthy priced',
      'Healthy points',
    ]);
  });

  it('check order per offer: budget (baseline) beats denylist beats margin (first reason wins)', () => {
    const merchantId = newId('mer');
    const cid = newId('com');
    const offer = mkOffer({
      merchant_id: merchantId,
      title: 'CLEARANCE blowout',
      mechanics: { type: 'percentage_off', pct_bps: 9000 },
    });
    const settings: GuardrailSettings = {
      margin_ceiling_bps: 1000,
      denylist: { categories: [], terms: ['clearance'] },
    };
    // all three rules would fire; the baseline budget rule reports first
    const exhausted = applyGuardrails(
      [mkRanked(offer, cid)],
      inputs({ statuses: { [cid]: okStatus(0) }, settings: { [merchantId]: settings } }),
      listPriceFor,
    );
    expect(exhausted.suppressed).toEqual([
      { offer_id: offer.offer_id, reason: 'BUDGET_EXHAUSTED' },
    ]);
    // with budget healthy, denylist beats margin
    const funded = applyGuardrails(
      [mkRanked(offer, cid)],
      inputs({ statuses: { [cid]: okStatus(5000) }, settings: { [merchantId]: settings } }),
      listPriceFor,
    );
    expect(funded.suppressed).toEqual([
      { offer_id: offer.offer_id, reason: 'BRAND_DENYLIST' },
    ]);
  });
});
