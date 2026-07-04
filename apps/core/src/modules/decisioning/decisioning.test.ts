import {
  MECHANICS_FIXTURES,
  RankedOffer,
  newId,
  type DecisionCtx,
  type EligibleOffer,
} from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { NoopGuardrails } from '../guardrails/index.js';
import { PassthroughDecisioner, RandomDecisioner } from './index.js';

const ctx: DecisionCtx = { agent: { agent_id: null }, tier: 'T3', segment: 't3-acquisition' };

const eligible: EligibleOffer[] = MECHANICS_FIXTURES.slice(0, 6).map((mechanics, index) => ({
  offer: {
    offer_id: newId('off'),
    merchant_id: newId('mer'),
    title: `Offer ${index}`,
    description: 'Fixture',
    mechanics,
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    status: 'live',
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
  commitment_id: index % 2 === 0 ? newId('com') : null,
}));

/** The CORE-7 accept, staged: schema (not values) identical across the swap.
 * `score` is optional decisioner colour in the contract either way, so the
 * shape fingerprint excludes it — the parse target never changes. */
const shapeOf = (ranked: RankedOffer[]): string =>
  JSON.stringify(
    ranked.map((entry) => ({
      keys: Object.keys(entry).filter((k) => k !== 'score').sort(),
      offerKeys: Object.keys(entry.offer).sort(),
      parses: RankedOffer.safeParse(entry).success,
    })),
  );

describe('decisioning slot + guardrails stubs (CORE-7 accept)', () => {
  it('swapping Passthrough for Random changes ranking only — no schema diffs', async () => {
    const passthrough = await new PassthroughDecisioner().rank(eligible, ctx);
    const random = await new RandomDecisioner(1337).rank(eligible, ctx);

    // same membership…
    const ids = (r: RankedOffer[]) => [...r].map((e) => e.offer.offer_id).sort();
    expect(ids(random)).toEqual(ids(passthrough));
    // …different order (the decisioner actually decides)…
    expect(random.map((e) => e.offer.offer_id)).not.toEqual(
      passthrough.map((e) => e.offer.offer_id),
    );
    // …and byte-identical response SHAPE under both.
    expect(shapeOf(random)).toBe(shapeOf(passthrough));
    for (const entry of [...passthrough, ...random]) {
      expect(RankedOffer.safeParse(entry).success).toBe(true);
    }
  });

  it('PassthroughDecisioner is stable and deterministic (offer_id order)', async () => {
    const decisioner = new PassthroughDecisioner();
    const first = await decisioner.rank(eligible, ctx);
    const second = await decisioner.rank([...eligible].reverse(), ctx);
    expect(first.map((e) => e.offer.offer_id)).toEqual(second.map((e) => e.offer.offer_id));
    expect(first.map((e) => e.offer.offer_id)).toEqual(
      [...eligible].map((e) => e.offer.offer_id).sort(),
    );
  });

  it('RandomDecisioner is deterministic per seed, different across seeds', async () => {
    const a = await new RandomDecisioner(7).rank(eligible, ctx);
    const b = await new RandomDecisioner(7).rank(eligible, ctx);
    const c = await new RandomDecisioner(8).rank(eligible, ctx);
    expect(a.map((e) => e.offer.offer_id)).toEqual(b.map((e) => e.offer.offer_id));
    expect(a.map((e) => e.offer.offer_id)).not.toEqual(c.map((e) => e.offer.offer_id));
  });

  it('NoopGuardrails passes everything and suppresses nothing', async () => {
    const ranked = await new PassthroughDecisioner().rank(eligible, ctx);
    const result = new NoopGuardrails().apply(ranked, ctx);
    expect(result.passed).toEqual(ranked);
    expect(result.suppressed).toEqual([]);
  });
});
