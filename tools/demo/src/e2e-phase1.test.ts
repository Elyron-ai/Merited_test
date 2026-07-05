import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPhase1World,
  runFailureDrills,
  runWalletlessFlow,
  runWalletPathFlow,
  type DrillEvidence,
  type Phase1World,
  type WalletlessEvidence,
  type WalletPathEvidence,
} from './e2e-phase1.js';

/**
 * PH1-27 accept, in CI: both flows green against the REAL trio on a clean
 * machine; §6.1/§6.4 negative cases fire on real rails; the under-reporting
 * drill alerts within one projection cycle; ONE trace ID spans each flow.
 */
let world: Phase1World;
let walletless: WalletlessEvidence;
let walletPath: WalletPathEvidence;
let drills: DrillEvidence;

beforeAll(async () => {
  world = await createPhase1World();
  walletless = await runWalletlessFlow(world);
  walletPath = await runWalletPathFlow(world);
  drills = await runFailureDrills(world);
}, 240_000);

afterAll(async () => {
  await world.close();
});

describe('full-dress FakeAurora go-live (PH1-27, SYN-33)', () => {
  it('(a) the walletless loop verifies end-to-end on REAL crypto', () => {
    expect(walletless.token.startsWith('v4.public.')).toBe(true);
    expect(walletless.token.startsWith('v4.public.fake.')).toBe(false); // real PASETO
    expect(walletless.verdict).toBe('verified');
    expect(walletless.chainOk).toBe(true);
  });

  it('(a) ONE trace ID spans read → mint → checkout → webhook → verify → ledger', () => {
    expect(walletless.eventTraceId).toBe(walletless.traceId);
  });

  it('(b) link → mandate → T1 quote → push → approve → re-mint(apr) → verified → points credited', () => {
    expect(walletPath.linkId).toMatch(/^lnk_/);
    expect(walletPath.tier).toBe('T1'); // the link IS the tier
    expect(walletPath.pushPayload.deep_link).toBe(`/approve/${walletPath.pushPayload.quote.quote_id}`);
    expect(walletPath.pushPayload.title).toContain('£84.50'); // pence-formatted, UK English
    expect(walletPath.approvalMode).toBe('explicit'); // above pre_authorised_up_to
    expect(walletPath.remintApr).toMatch(/^apr_/); // same qid, fresh jti, apr set
    expect(walletPath.verdict).toBe('verified'); // approval + limit checks passed on real rails
    expect(walletPath.pointsAfter).toBe(walletPath.pointsBefore + 84); // credited ONCE despite the replayed credit call
  });

  it('(b) ONE trace ID spans the wallet-path conversion', () => {
    expect(walletPath.eventTraceId).toBe(walletPath.traceId);
  });

  it('(b) §6.1/§6.4 negatives fire on real rails', () => {
    expect(walletPath.negatives.revokedMandate).toBe('MANDATE_REVOKED'); // mid-flow revocation
    expect(walletPath.negatives.executeWithoutApproval).toBe('APPROVAL_MISSING'); // wallet-path claim, no apr
  });

  it('(c) the under-reporting drill alerts within ONE projection cycle', () => {
    expect(drills.underReporting.status).toBe('under_reporting');
    expect(drills.underReporting.alerts).toBe(1);
  });

  it('(c) a replayed webhook produces exactly ONE claim', () => {
    expect(drills.webhookReplay).toEqual({ deliveries: 2, claims: 1 });
  });
});
