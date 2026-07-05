import {
  pence,
  type EligibilityRule,
  type EligibleOffer,
  type MeritedId,
  type Offer,
} from '@merited/contracts';
import { frozenClock, seededIdFactory } from '@merited/contracts/testing';
import { canonicalJson } from '@merited/events';
import { describe, expect, it } from 'vitest';
import { consumerValueScore } from './stacking.js';
import { filterEligibility } from './pipeline.js';

/** PH1-3 fixtures, kit-built (ADR-002). */
const buildFixtures = () => {
  const ids = seededIdFactory(3054);
  const merchantId = ids.next('mer');
  const agentId = ids.next('agt');
  const offIds = Array.from({ length: 6 }, () => ids.next('off'));

  const baseOffer = (n: number, overrides: Partial<Offer> = {}): Offer => ({
    offer_id: offIds[n - 1]!,
    merchant_id: merchantId,
    title: `Offer ${n}`,
    description: 'Fixture',
    mechanics: { type: 'fixed_off', value: pence(500) },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    status: 'live',
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
    ...overrides,
  });

  const rule = (partial: Record<string, unknown>): EligibilityRule =>
    ({
      rule_id: `elr_${partial['type']}`,
      merchant_id: merchantId,
      note: null,
      created_at: '2026-07-05T00:00:00Z',
      ...partial,
    }) as EligibilityRule;

  const input = {
    tier: 'T1' as const,
    now: frozenClock('2026-07-05T12:00:00Z').now(),
    commitmentStatuses: new Map(),
    agentId,
    segment: 't1-gold-returning' as const,
  };

  return { ids, merchantId, agentId, offIds, baseOffer, rule, input };
};

describe('PH1-3 — stacking by best consumer value', () => {
  it('two live offers in one group return exactly ONE eligible — the better value', () => {
    const fx = buildFixtures();
    const weaker: EligibleOffer = {
      offer: fx.baseOffer(1, { stacking_group: 'summer', mechanics: { type: 'fixed_off', value: pence(500) } }),
      commitment_id: null,
    };
    const stronger: EligibleOffer = {
      offer: fx.baseOffer(2, { stacking_group: 'summer', mechanics: { type: 'percentage_off', pct_bps: 2000 } }),
      commitment_id: null,
    };
    // 20% of the £100 reference (£20.00) beats £5.00 off
    expect(consumerValueScore(stronger.offer)).toBeGreaterThan(consumerValueScore(weaker.offer));
    const result = filterEligibility([weaker, stronger], fx.input);
    expect(result.eligible.map((e) => e.offer.offer_id)).toEqual([stronger.offer.offer_id]);
    expect(result.excluded).toEqual([
      { offer_id: weaker.offer.offer_id, reason: 'STACKING_DEDUPED' },
    ]);
  });

  it('equal value ties break stable by offer_id — deterministic across orderings', () => {
    const fx = buildFixtures();
    const a: EligibleOffer = { offer: fx.baseOffer(1, { stacking_group: 'g' }), commitment_id: null };
    const b: EligibleOffer = { offer: fx.baseOffer(2, { stacking_group: 'g' }), commitment_id: null };
    const forward = filterEligibility([a, b], fx.input);
    const reversed = filterEligibility([b, a], fx.input);
    expect(forward.eligible.map((e) => e.offer.offer_id)).toEqual([a.offer.offer_id]);
    expect(reversed.eligible.map((e) => e.offer.offer_id)).toEqual([a.offer.offer_id]);
  });
});

describe('PH1-3 — merchant exclusion rules (stage 5)', () => {
  it('agent, tier/segment and SKU rules each exclude with MERCHANT_EXCLUDED', () => {
    const fx = buildFixtures();
    const offers: EligibleOffer[] = [
      { offer: fx.baseOffer(1), commitment_id: null },
      { offer: fx.baseOffer(2, { sku_scope: ['sku_spa_day'] }), commitment_id: null },
      { offer: fx.baseOffer(3, { sku_scope: ['sku_lunch'] }), commitment_id: null },
    ];

    // agent rule excludes everything from this merchant for that agent
    const agentRule = fx.rule({ type: 'merchant_agent_exclusion', agent_id: fx.agentId });
    let result = filterEligibility(offers, { ...fx.input, rules: [agentRule] });
    expect(result.eligible).toEqual([]);
    expect(result.excluded.every((e) => e.reason === 'MERCHANT_EXCLUDED')).toBe(true);
    // …but a DIFFERENT agent sails through
    result = filterEligibility(offers, {
      ...fx.input,
      agentId: 'agt_00000000000000000000000009',
      rules: [agentRule],
    });
    expect(result.eligible).toHaveLength(3);

    // tier rule
    const tierRule = fx.rule({ type: 'merchant_tier_exclusion', tier: 'T1', segment: null });
    result = filterEligibility(offers, { ...fx.input, rules: [tierRule] });
    expect(result.eligible).toEqual([]);
    // segment-half of the rule
    const segmentRule = fx.rule({
      type: 'merchant_tier_exclusion',
      tier: null,
      segment: 't1-gold-returning',
    });
    result = filterEligibility(offers, { ...fx.input, rules: [segmentRule] });
    expect(result.eligible).toEqual([]);

    // sku rule hits the matching scope AND 'all'-scoped offers, not others
    const skuRule = fx.rule({ type: 'merchant_sku_exclusion', sku_ref: 'sku_spa_day' });
    result = filterEligibility(offers, { ...fx.input, rules: [skuRule] });
    expect(result.eligible.map((e) => e.offer.offer_id)).toEqual([offers[2]!.offer.offer_id]);
    expect(
      result.excluded.filter((e) => e.reason === 'MERCHANT_EXCLUDED').map((e) => e.offer_id).sort(),
    ).toEqual([offers[0]!.offer.offer_id, offers[1]!.offer.offer_id].sort());
  });

  it('rules for OTHER merchants never touch this merchant’s offers', () => {
    const fx = buildFixtures();
    const foreignRule = {
      ...fx.rule({ type: 'merchant_agent_exclusion', agent_id: fx.agentId }),
      merchant_id: 'mer_00000000000000000000000009' as MeritedId<'mer'>,
    } as EligibilityRule;
    const result = filterEligibility(
      [{ offer: fx.baseOffer(1), commitment_id: null }],
      { ...fx.input, rules: [foreignRule] },
    );
    expect(result.eligible).toHaveLength(1);
  });

  it('§5.4 accept: output is byte-identical across runs WITH rules in play', () => {
    const build = () => {
      const fx = buildFixtures();
      const offers: EligibleOffer[] = [
        { offer: fx.baseOffer(1, { stacking_group: 's' }), commitment_id: null },
        { offer: fx.baseOffer(2, { stacking_group: 's', mechanics: { type: 'percentage_off', pct_bps: 1500 } }), commitment_id: null },
        { offer: fx.baseOffer(3, { sku_scope: ['sku_spa_day'] }), commitment_id: null },
        { offer: fx.baseOffer(4, { status: 'draft' }), commitment_id: null },
      ];
      const rules = [fx.rule({ type: 'merchant_sku_exclusion', sku_ref: 'sku_spa_day' })];
      return canonicalJson(filterEligibility(offers, { ...fx.input, rules }));
    };
    const first = build();
    expect(build()).toBe(first);
    expect(build()).toBe(first);
  });
});
