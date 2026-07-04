import { describe, expect, it } from 'vitest';
import { act1Steps, type Act1Handles } from '../src/act1.js';
import { runAct, StepFailedError, type DemoStep } from '../src/harness.js';

/**
 * XC-8 accept, the load-bearing half: "disabling replay rejection fails
 * CI". The demo IS the E2E, so the proof is a mutation test over act 1's
 * OWN step asserts: feed each assert the outcome a broken platform would
 * produce and demand it throws — then push one through the harness to show
 * the run (and therefore the demo-e2e job) goes red, not just a warning.
 * Asserts are pure; no live platform is needed to prove them load-bearing.
 */

const steps = act1Steps({} as Act1Handles);
const stepNo = (n: number): DemoStep => {
  const found = steps.find((s) => s.number === n);
  if (!found) throw new Error(`act 1 has no step ${n}`);
  return found;
};

const goodNegatives = {
  replay: { type: 'CLAIM_REJECTED', reason_code: 'TOKEN_REPLAYED' },
  expired: { type: 'CLAIM_REJECTED', reason_code: 'QUOTE_EXPIRED' },
};

const goodEntries = [
  { account: 'merchant_payable:mer_x', side: 'dr', amount: { amount: 1200 } },
  { account: 'agent_receivable:agt_x', side: 'cr', amount: { amount: 720 } },
  { account: 'platform_revenue', side: 'cr', amount: { amount: 240 } },
  { account: 'reserve:mer_x', side: 'cr', amount: { amount: 240 } },
];

describe('act 1 asserts are load-bearing (XC-8)', () => {
  it('step 8 accepts the real refusals — and REFUSES a platform that stopped rejecting replays', () => {
    const negatives = stepNo(8);
    expect(() => negatives.assert(goodNegatives)).not.toThrow();
    // replay rejection disabled: the duplicate claim comes back accepted
    expect(() =>
      negatives.assert({ ...goodNegatives, replay: { type: 'CLAIM_ACCEPTED' } }),
    ).toThrow(/TOKEN_REPLAYED/);
    // or rejected under the wrong code
    expect(() =>
      negatives.assert({
        ...goodNegatives,
        replay: { type: 'CLAIM_REJECTED', reason_code: 'SIG_INVALID' },
      }),
    ).toThrow(/TOKEN_REPLAYED/);
    // quote-expiry rejection disabled
    expect(() =>
      negatives.assert({ ...goodNegatives, expired: { type: 'CLAIM_ACCEPTED' } }),
    ).toThrow(/QUOTE_EXPIRED/);
  });

  it('step 6 pins the exact splits — a drifted rate or unbalanced set throws', () => {
    const splits = stepNo(6);
    expect(() => splits.assert(goodEntries)).not.toThrow();
    const drifted = goodEntries.map((l) =>
      l.account.startsWith('agent_receivable') ? { ...l, amount: { amount: 730 } } : l,
    );
    expect(() => splits.assert(drifted)).toThrow(/£7\.20/);
    const unbalanced = [...goodEntries, { account: 'reserve:mer_x', side: 'cr', amount: { amount: 1 } }];
    expect(() => splits.assert(unbalanced)).toThrow(/trial balance/);
  });

  it('step 9 demands one trace and a verified chain', () => {
    const chain = stepNo(9);
    const good = { ledgerTraceId: 'abc', flowTraceId: 'abc', verification: { ok: true } };
    expect(() => chain.assert(good)).not.toThrow();
    expect(() => chain.assert({ ...good, verification: { ok: false } })).toThrow(/verify-chain/);
    expect(() => chain.assert({ ...good, ledgerTraceId: 'zzz' })).toThrow(/trace mismatch/);
  });

  it('a mutated outcome reds the whole run through the harness — CI fails, not warns', async () => {
    const sabotaged: DemoStep = {
      number: 8,
      title: stepNo(8).title,
      narrative: 'Simulated: replay rejection disabled.',
      run: async () => ({ ...goodNegatives, replay: { type: 'CLAIM_ACCEPTED' } }),
      assert: stepNo(8).assert,
    };
    const error = await runAct([sabotaged], {
      act: 'act-mutation',
      outRoot: `${process.env['TMPDIR'] ?? '/tmp'}/merited-mutation-${process.pid}`,
      print: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepFailedError);
    expect((error as StepFailedError).message).toContain('TOKEN_REPLAYED');
  });
});
