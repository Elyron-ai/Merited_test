import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhase1World, type Phase1World } from '../src/e2e-phase1.js';
import { runAct2, type Act2Evidence } from '../src/act2.js';

/**
 * PH2-11 accept — the Phase-2 gate sentence: "pnpm demo:act2 — the wallet
 * act — end-to-end on real rails: link Aurora Club → brief Valet →
 * notification → approve → transact → points credited on the activity
 * screen." Both §10 negative cases fire; ONE trace spans brief → ledger.
 * PH2-5's deferred clause closes here too: under VALET_DETERMINISTIC=1 the
 * demo transcript is BYTE-IDENTICAL run to run, no model network access.
 */
process.env['VALET_DETERMINISTIC'] = '1';

let world: Phase1World;
let first: Act2Evidence;

beforeAll(async () => {
  world = await createPhase1World();
  first = await runAct2(world, { email: 'act2.ci.one@example.co.uk', quiet: true });
}, 300_000);

afterAll(async () => {
  await world.close();
});

describe('demo Act 2 (PH2-11) — the nine §10 steps in CI', () => {
  it('GATE SENTENCE: link → brief → notification → approve → transact → points credited', () => {
    expect(first.scopesShown).toContain('tier'); // scopes shown on the consent screen
    expect(first.linkSubHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.states).toEqual([
      'SEARCHING', 'QUOTED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'CONFIRMED',
    ]);
    expect(first.t1.tier).toBe('T1');
    expect(first.t3.tier).toBe('T3');
    expect(first.pushDeepLink).toMatch(/^\/approve\/qte_/);
    expect(first.approvalMode).toBe('explicit'); // £84.50 > £50 pre-auth
    expect(first.remintApr).toMatch(/^apr_/); // token re-minted WITH apr
    expect(first.claimId).toMatch(/^clm_/);
    expect(first.pointsCredited).toBe(84); // ⌊£84.50⌋ on the activity screen
  });

  it('both §10 negatives demonstrably fire — and nothing was charged by them', () => {
    expect(first.revokedReason).toBe('MANDATE_REVOKED');
    expect(first.declinedState).toBe('DECLINED');
    expect(first.chargedDuringNegatives).toBe(false);
  });

  it('ONE trace spans brief → ledger: the ConversionVerified event carries the flow trace id', () => {
    expect(first.eventTraceId).toBe(first.traceId);
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('PH2-5 clause: under VALET_DETERMINISTIC=1 the transcript is BYTE-IDENTICAL run to run', async () => {
    const second = await runAct2(world, { email: 'act2.ci.two@example.co.uk', quiet: true });
    expect(second.transcript.join('\n')).toBe(first.transcript.join('\n'));
    expect(first.transcript.join('\n')).not.toMatch(/qte_|ern_|apr_|clm_|mnd_|lnk_|\d{4}-\d{2}-\d{2}T/);
  }, 240_000);
});
