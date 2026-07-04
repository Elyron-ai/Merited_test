import {
  EligibilityResult,
  pence,
  type CommitmentStatus,
  type EligibleOffer,
  type MeritedId,
  type Offer,
} from '@merited/contracts';
import { frozenClock, seededIdFactory } from '@merited/contracts/testing';
import { canonicalJson } from '@merited/events';
import { describe, expect, it } from 'vitest';
import { fetchCommitmentStatuses, filterEligibility } from './filter.js';

/**
 * Fixtures built through the deterministic test kit (XC-5): a fresh seeded
 * factory per construction — the SAME seed must reproduce the SAME ids, so
 * building twice and comparing bytes is the kit's acceptance proof. D6
 * discipline without hand-writing a single 26-char ULID body.
 */
const buildFixtures = () => {
  const ids = seededIdFactory(2026);
  const merchantId = ids.next('mer');
  const offIds = Array.from({ length: 9 }, () => ids.next('off'));
  const comIds = Array.from({ length: 9 }, () => ids.next('com'));
  const off = (n: number): MeritedId<'off'> => offIds[n - 1]!;
  const com = (n: number): MeritedId<'com'> => comIds[n - 1]!;

  const baseOffer = (n: number, overrides: Partial<Offer> = {}): Offer => ({
    offer_id: off(n),
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

  const liveStatus = (n: number, used = 0, max: number | null = 500): CommitmentStatus => ({
    commitment_id: com(n),
    status: 'live',
    conversions_used: used,
    max_conversions: max,
    budget_remaining: null,
  });

  // The seeded fixture set: 8 offers covering all four filter outcomes.
  const candidates: EligibleOffer[] = [
    { offer: baseOffer(1, { stacking_group: 'summer' }), commitment_id: com(1) }, // eligible, stacking winner
    { offer: baseOffer(2, { stacking_group: 'summer' }), commitment_id: com(2) }, // STACKING_DEDUPED
    { offer: baseOffer(3, { status: 'draft' }), commitment_id: null }, // OFFER_NOT_LIVE
    { offer: baseOffer(4, { valid_until: '2026-07-02T00:00:00Z' }), commitment_id: null }, // OFFER_NOT_LIVE (window)
    { offer: baseOffer(5, { identity_tiers: ['T1'] }), commitment_id: com(5) }, // TIER_INELIGIBLE for T3
    { offer: baseOffer(6), commitment_id: com(6) }, // COMMITMENT_ENDED
    { offer: baseOffer(7), commitment_id: com(7) }, // CAP_EXHAUSTED
    { offer: baseOffer(8), commitment_id: null }, // eligible, no COR
  ];

  const statuses = new Map<string, CommitmentStatus>([
    [com(1), liveStatus(1)],
    [com(2), liveStatus(2)],
    [com(5), liveStatus(5)],
    [com(6), { ...liveStatus(6), status: 'ended' }],
    [com(7), liveStatus(7, 3, 3)],
  ]);

  const input = {
    tier: 'T3' as const,
    now: frozenClock('2026-07-04T12:00:00Z').now(),
    commitmentStatuses: statuses,
  };

  return { off, com, baseOffer, liveStatus, candidates, statuses, input };
};

const fx = buildFixtures();

describe('eligibility filters (CORE-6 accept, §5.4)', () => {
  it('XC-5 accept: the fixture suite built twice through the kit yields byte-identical output', () => {
    const first = buildFixtures();
    const second = buildFixtures();
    const outFirst = canonicalJson(filterEligibility(first.candidates, first.input));
    const outSecond = canonicalJson(filterEligibility(second.candidates, second.input));
    expect(outSecond).toBe(outFirst);
    // and stable across repeated runs of the same construction
    expect(canonicalJson(filterEligibility(first.candidates, first.input))).toBe(outFirst);
  });

  it('every filter outcome lands exactly as specified, in fixed order', () => {
    const result = filterEligibility(fx.candidates, fx.input);
    expect(EligibilityResult.parse(result)).toEqual(result);
    expect(result.eligible.map((e) => e.offer.offer_id)).toEqual([fx.off(1), fx.off(8)]);
    expect(result.excluded).toEqual([
      { offer_id: fx.off(3), reason: 'OFFER_NOT_LIVE' },
      { offer_id: fx.off(4), reason: 'OFFER_NOT_LIVE' },
      { offer_id: fx.off(5), reason: 'TIER_INELIGIBLE' },
      { offer_id: fx.off(6), reason: 'COMMITMENT_ENDED' },
      { offer_id: fx.off(7), reason: 'CAP_EXHAUSTED' },
      { offer_id: fx.off(2), reason: 'STACKING_DEDUPED' },
    ]);
  });

  it('first failure wins: a draft offer that is also tier-ineligible reports OFFER_NOT_LIVE', () => {
    const both: EligibleOffer = {
      offer: fx.baseOffer(9, { status: 'paused', identity_tiers: ['T1'] }),
      commitment_id: fx.com(6),
    };
    const result = filterEligibility([both], fx.input);
    expect(result.excluded).toEqual([{ offer_id: fx.off(9), reason: 'OFFER_NOT_LIVE' }]);
  });

  it('an unknown commitment status excludes conservatively as COMMITMENT_ENDED', () => {
    const orphan: EligibleOffer = { offer: fx.baseOffer(9), commitment_id: fx.com(9) };
    const result = filterEligibility([orphan], fx.input);
    expect(result.excluded).toEqual([{ offer_id: fx.off(9), reason: 'COMMITMENT_ENDED' }]);
  });

  it('tier gating follows the resolved tier, not the offer order', () => {
    const t1Input = { ...fx.input, tier: 'T1' as const };
    const result = filterEligibility(fx.candidates, t1Input);
    expect(result.eligible.map((e) => e.offer.offer_id)).toContain(fx.off(5));
  });

  it('fetchCommitmentStatuses batches one lookup per distinct COR and drops nulls', async () => {
    const calls: string[] = [];
    const map = await fetchCommitmentStatuses(
      [
        { offer: fx.baseOffer(1), commitment_id: fx.com(1) },
        { offer: fx.baseOffer(2), commitment_id: fx.com(1) }, // duplicate COR
        { offer: fx.baseOffer(3), commitment_id: fx.com(9) }, // unknown
        { offer: fx.baseOffer(4), commitment_id: null },
      ],
      async (cid) => {
        calls.push(cid);
        return cid === fx.com(1) ? fx.liveStatus(1) : null;
      },
    );
    expect(calls.sort()).toEqual([fx.com(1), fx.com(9)].sort());
    expect([...map.keys()]).toEqual([fx.com(1)]);
  });
});
