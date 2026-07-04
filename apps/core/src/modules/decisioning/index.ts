import type { DecisionCtx, Decisioner, EligibleOffer, RankedOffer } from '@merited/contracts';

/**
 * Decisioning slot, Phase-0 stubs (CORE-7, B7 position). The interface is
 * frozen in contracts; B7's RulesDecisioner (Ph1) and the ML sidecar (Ph2)
 * slot in behind it with zero pipeline changes (P4).
 */

/** Ph0 PRODUCTION decisioner: stable order, no opinions. */
export class PassthroughDecisioner implements Decisioner {
  async rank(eligible: EligibleOffer[], _ctx: DecisionCtx): Promise<RankedOffer[]> {
    return [...eligible]
      .sort((a, b) => (a.offer.offer_id < b.offer.offer_id ? -1 : 1))
      .map((entry) => ({ ...entry }));
  }
}

/** Deterministic seeded PRNG (mulberry32) — test-only ranking shuffler. */
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** TEST-ONLY decisioner: proves the swap changes ranking, never schema. */
export class RandomDecisioner implements Decisioner {
  constructor(private readonly seed: number) {}

  async rank(eligible: EligibleOffer[], _ctx: DecisionCtx): Promise<RankedOffer[]> {
    const next = mulberry32(this.seed);
    return [...eligible]
      .map((entry) => ({ entry, key: next() }))
      .sort((a, b) => a.key - b.key)
      .map(({ entry, key }) => ({ ...entry, score: key }));
  }
}
