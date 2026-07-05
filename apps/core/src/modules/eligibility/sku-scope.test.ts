import { newId, pence, type EligibleOffer } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { filterEligibility, skuMatches } from './pipeline.js';

/**
 * PH3-9, the §5.4-pattern determinism tests for the SKU stage: pure inputs
 * in, identical results out, every exclusion carrying the machine-readable
 * SKU_MISMATCH reason (a READ-path literal — §3's claim enum is untouched).
 */

const offerWith = (
  overrides: Partial<EligibleOffer['offer']> = {},
): EligibleOffer => ({
  commitment_id: null,
  offer: {
    offer_id: newId('off'),
    merchant_id: newId('mer'),
    title: 'Spa day',
    description: 'Spa day',
    mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    status: 'live',
    valid_from: '2026-01-01T00:00:00Z',
    valid_until: '2027-01-01T00:00:00Z',
    ...overrides,
  },
});

const input = (sku: string | null) => ({
  tier: 'T3' as const,
  now: new Date('2026-07-05T12:00:00Z'),
  commitmentStatuses: new Map(),
  sku,
});

describe('PH3-9 SKU scope in the pure eligibility chain', () => {
  const scoped = offerWith({ sku_scope: ['sku_spa_day'] });
  const openScope = offerWith({ sku_scope: 'all' });
  const bundle = offerWith({
    sku_scope: ['sku_spa_day', 'sku_lunch'],
    mechanics: { type: 'bundle', sku_refs: ['sku_spa_day', 'sku_lunch'], value: pence(9900) },
  });

  it('a scoped offer is eligible ONLY for matching SKU queries; mismatches carry SKU_MISMATCH', () => {
    const match = filterEligibility([scoped], input('sku_spa_day'));
    expect(match.eligible.map((e) => e.offer.offer_id)).toEqual([scoped.offer.offer_id]);

    const miss = filterEligibility([scoped], input('sku_massage'));
    expect(miss.eligible).toHaveLength(0);
    expect(miss.excluded).toEqual([{ offer_id: scoped.offer.offer_id, reason: 'SKU_MISMATCH' }]);
  });

  it("REGRESSION: sku_scope 'all' behaviour unchanged — matches every SKU and no-sku reads", () => {
    for (const sku of ['sku_spa_day', 'sku_massage', 'sku_anything', null]) {
      const result = filterEligibility([openScope], input(sku));
      expect(result.eligible).toHaveLength(1);
      expect(result.excluded).toHaveLength(0);
    }
  });

  it('bundle sku_refs RESOLVE: asking for any bundled SKU surfaces the bundle', () => {
    expect(skuMatches(bundle.offer, 'sku_lunch')).toBe(true);
    expect(skuMatches(bundle.offer, 'sku_spa_day')).toBe(true);
    expect(skuMatches(bundle.offer, 'sku_candle')).toBe(false);

    const viaBundleContent = filterEligibility(
      [offerWith({ sku_scope: ['sku_other'], mechanics: { type: 'bundle', sku_refs: ['sku_lunch'], value: pence(5000) } })],
      input('sku_lunch'),
    );
    expect(viaBundleContent.eligible).toHaveLength(1); // matched via sku_refs, not scope
  });

  it('DETERMINISM (§5.4 pattern): identical inputs → byte-identical results, any candidate order', () => {
    const candidates = [scoped, openScope, bundle];
    const first = filterEligibility(candidates, input('sku_spa_day'));
    const second = filterEligibility(candidates, input('sku_spa_day'));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const reversed = filterEligibility([...candidates].reverse(), input('sku_spa_day'));
    expect(new Set(reversed.eligible.map((e) => e.offer.offer_id))).toEqual(
      new Set(first.eligible.map((e) => e.offer.offer_id)),
    );
  });

  it('no SKU on the read → the stage is inert (Phase-0 behaviour preserved)', () => {
    const result = filterEligibility([scoped, openScope, bundle], input(null));
    expect(result.eligible).toHaveLength(3);
  });
});
