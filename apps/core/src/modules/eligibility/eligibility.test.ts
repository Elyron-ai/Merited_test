import {
  EligibilityResult,
  pence,
  type CommitmentStatus,
  type EligibleOffer,
  type Offer,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { describe, expect, it } from 'vitest';
import { fetchCommitmentStatuses, filterEligibility } from './filter.js';

// Hand-written stable ids (D6 discipline): determinism must be byte-exact.
const off = (n: number): `off_${string}` => `off_0000000000000000000000000${n}` as `off_${string}`;
const com = (n: number): `com_${string}` => `com_0000000000000000000000000${n}` as `com_${string}`;

const baseOffer = (n: number, overrides: Partial<Offer> = {}): Offer => ({
  offer_id: off(n),
  merchant_id: 'mer_00000000000000000000000000',
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
  now: new Date('2026-07-04T12:00:00Z'), // frozen clock
  commitmentStatuses: statuses,
};

describe('eligibility filters (CORE-6 accept, §5.4)', () => {
  it('the seeded fixture produces byte-identical output across three runs (canonical JSON)', () => {
    const runs = [1, 2, 3].map(() => canonicalJson(filterEligibility(candidates, input)));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('every filter outcome lands exactly as specified, in fixed order', () => {
    const result = filterEligibility(candidates, input);
    expect(EligibilityResult.parse(result)).toEqual(result);
    expect(result.eligible.map((e) => e.offer.offer_id)).toEqual([off(1), off(8)]);
    expect(result.excluded).toEqual([
      { offer_id: off(3), reason: 'OFFER_NOT_LIVE' },
      { offer_id: off(4), reason: 'OFFER_NOT_LIVE' },
      { offer_id: off(5), reason: 'TIER_INELIGIBLE' },
      { offer_id: off(6), reason: 'COMMITMENT_ENDED' },
      { offer_id: off(7), reason: 'CAP_EXHAUSTED' },
      { offer_id: off(2), reason: 'STACKING_DEDUPED' },
    ]);
  });

  it('first failure wins: a draft offer that is also tier-ineligible reports OFFER_NOT_LIVE', () => {
    const both: EligibleOffer = {
      offer: baseOffer(9, { status: 'paused', identity_tiers: ['T1'] }),
      commitment_id: com(6),
    };
    const result = filterEligibility([both], input);
    expect(result.excluded).toEqual([{ offer_id: off(9), reason: 'OFFER_NOT_LIVE' }]);
  });

  it('an unknown commitment status excludes conservatively as COMMITMENT_ENDED', () => {
    const orphan: EligibleOffer = { offer: baseOffer(9), commitment_id: com(9) };
    const result = filterEligibility([orphan], input);
    expect(result.excluded).toEqual([{ offer_id: off(9), reason: 'COMMITMENT_ENDED' }]);
  });

  it('tier gating follows the resolved tier, not the offer order', () => {
    const t1Input = { ...input, tier: 'T1' as const };
    const result = filterEligibility(candidates, t1Input);
    expect(result.eligible.map((e) => e.offer.offer_id)).toContain(off(5));
  });

  it('fetchCommitmentStatuses batches one lookup per distinct COR and drops nulls', async () => {
    const calls: string[] = [];
    const map = await fetchCommitmentStatuses(
      [
        { offer: baseOffer(1), commitment_id: com(1) },
        { offer: baseOffer(2), commitment_id: com(1) }, // duplicate COR
        { offer: baseOffer(3), commitment_id: com(9) }, // unknown
        { offer: baseOffer(4), commitment_id: null },
      ],
      async (cid) => {
        calls.push(cid);
        return cid === com(1) ? liveStatus(1) : null;
      },
    );
    expect(calls.sort()).toEqual([com(1), com(9)]);
    expect([...map.keys()]).toEqual([com(1)]);
  });
});
