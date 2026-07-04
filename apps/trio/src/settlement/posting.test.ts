import { COMMITMENT_FIXTURE, FIXTURE_IDS, type Commitment } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { bountyFor, conversionEntrySet, splitBounty } from './posting.js';

describe('posting.ts pure functions (TRIO-9 accept)', () => {
  it('reproduces the demo canonical numbers exactly (Act 1 step 6)', () => {
    const set = conversionEntrySet({
      commitment: COMMITMENT_FIXTURE, // 1200p fixed, 2000bps take, 6000bps commission
      agentId: FIXTURE_IDS.agent,
      claimId: FIXTURE_IDS.claim,
      grossPence: 8450,
    });
    expect(set.lines).toEqual([
      { account: `merchant_payable:${FIXTURE_IDS.merchant}`, side: 'dr', amount: { amount: 1200, currency: 'GBP_pence' } },
      { account: `agent_receivable:${FIXTURE_IDS.agent}`, side: 'cr', amount: { amount: 720, currency: 'GBP_pence' } },
      { account: 'platform_revenue', side: 'cr', amount: { amount: 240, currency: 'GBP_pence' } },
      { account: `reserve:${FIXTURE_IDS.merchant}`, side: 'cr', amount: { amount: 240, currency: 'GBP_pence' } },
    ]);
    const dr = set.lines.filter((l) => l.side === 'dr').reduce((s, l) => s + l.amount.amount, 0);
    const cr = set.lines.filter((l) => l.side === 'cr').reduce((s, l) => s + l.amount.amount, 0);
    expect(dr).toBe(cr); // trial balance zero
  });

  it('splitBounty floors and sends the rounding remainder to reserve (balances by construction)', () => {
    for (const [bounty, take, comm] of [
      [999, 3333, 3333],
      [1, 5000, 5000],
      [1200, 2000, 6000],
      [7, 1, 9998],
      [123456, 2500, 6000],
    ] as const) {
      const split = splitBounty(bounty, take, comm);
      expect(split.platform).toBe(Math.floor((bounty * take) / 10000));
      expect(split.agent).toBe(Math.floor((bounty * comm) / 10000));
      expect(split.platform + split.agent + split.reserve).toBe(bounty);
      expect(split.reserve).toBeGreaterThanOrEqual(0);
    }
  });

  it('pct_of_order bounty floors gross × pct_bps / 10000', () => {
    const pct: Commitment = {
      ...COMMITMENT_FIXTURE,
      bounty: { type: 'pct_of_order', pct_bps: 500 },
    };
    expect(bountyFor(pct, 8450)).toBe(422); // floor(8450*0.05)
    expect(bountyFor(COMMITMENT_FIXTURE, 8450)).toBe(1200); // fixed ignores gross
  });

  it('entry sets from the pure function always parse the balanced EntrySet schema', () => {
    const set = conversionEntrySet({
      commitment: { ...COMMITMENT_FIXTURE, take_rate_bps: 3333, agent_commission_bps: 3333 },
      agentId: FIXTURE_IDS.agent,
      claimId: FIXTURE_IDS.claim,
      grossPence: 999,
    });
    expect(set.lines).toHaveLength(4);
  });
});
