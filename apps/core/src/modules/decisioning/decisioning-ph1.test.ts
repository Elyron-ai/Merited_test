import { pence, type EligibleOffer, type Offer } from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { describe, expect, it } from 'vitest';
import { decisionerFor } from './registry.js';
import { RulesDecisioner } from './rules-decisioner.js';
import { PassthroughDecisioner, RandomDecisioner } from './index.js';

const ids = seededIdFactory(4011);
const merA = ids.next('mer');
const merB = ids.next('mer');

const offer = (n: number, overrides: Partial<Offer> = {}): EligibleOffer => ({
  offer: {
    offer_id: ids.next('off'),
    merchant_id: merA,
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
  },
  commitment_id: null,
});

const ctx = { agent: { agent_id: null }, tier: 'T1', segment: 't1-gold-new' } as never;

describe('RulesDecisioner v1 (PH1-4)', () => {
  it('ranks: merchant priority → bounty-bearing → consumer value → offer_id', async () => {
    const plain = offer(1); // merA, £5 off, no COR
    const bounty = { ...offer(2), commitment_id: ids.next('com') }; // merA, £5 off, COR
    const richer = offer(3, { mechanics: { type: 'percentage_off', pct_bps: 2000 } }); // merA, £20 value
    const prioritised = offer(4, { merchant_id: merB }); // merB, priority below

    const ranked = await new RulesDecisioner({ merchantPriority: { [merB]: 10 } }).rank(
      [plain, bounty, richer, prioritised],
      ctx,
    );
    expect(ranked.map((r) => r.offer.offer_id)).toEqual([
      prioritised.offer.offer_id, // priority 10 first
      bounty.offer.offer_id, // then bounty-bearing
      richer.offer.offer_id, // then better consumer value
      plain.offer.offer_id,
    ]);
  });

  it('equal everything ties break stable by offer_id, independent of input order', async () => {
    const a = offer(1);
    const b = offer(2);
    const decisioner = new RulesDecisioner();
    const forward = await decisioner.rank([a, b], ctx);
    const reversed = await decisioner.rank([b, a], ctx);
    expect(forward.map((r) => r.offer.offer_id)).toEqual(reversed.map((r) => r.offer.offer_id));
  });
});

describe('decisioner registry (PH1-4)', () => {
  it('selects by name with rules as the default; unknown names refuse at boot', () => {
    expect(decisionerFor(undefined)).toBeInstanceOf(RulesDecisioner);
    expect(decisionerFor('rules')).toBeInstanceOf(RulesDecisioner);
    expect(decisionerFor('passthrough')).toBeInstanceOf(PassthroughDecisioner);
    expect(decisionerFor('random:7')).toBeInstanceOf(RandomDecisioner);
    expect(() => decisionerFor('ml-sidecar')).toThrow('unknown MERITED_DECISIONER');
  });
});
