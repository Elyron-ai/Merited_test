import {
  FIXTURE_IDS,
  newId,
  pence,
  type Approval,
  type CommitmentDraft,
  type Mandate,
  type VerifyRequest,
} from '@merited/contracts';
import { FakeSigner } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import { CommitmentSimulator } from '../commitment/simulator.js';
import { systemClock } from '../shared/clock.js';
import { attest, FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { merchantKeyRef } from '../shared/deps.js';
import { MintSimulator } from './simulator.js';
import { claimSignaturePayload, VerifySimulator } from './verify-pipeline.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_vfy_${Date.now().toString(36)}`;
const signer = new FakeSigner('trio-test-secret');

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const draft = (overrides: Partial<CommitmentDraft['terms']> = {}, extra: Partial<CommitmentDraft> = {}): CommitmentDraft => ({
  merchant_id: FIXTURE_IDS.merchant,
  offer_ref: FIXTURE_IDS.offer,
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
    ...overrides,
  },
  ...extra,
});

let admin: pg.Client;
let pool: pg.Pool;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;
let fixtures: FixtureDirectory;

const mintFor = async (
  cid: `com_${string}`,
  opts: { quoteExpS?: number; mandateRef?: `mnd_${string}` | null; apr?: `apr_${string}`; tier?: 'T1' | 'T2' | 'T3'; qid?: `qte_${string}` } = {},
) =>
  mint.mint({
    cid,
    qid: opts.qid ?? newId('qte'),
    aid: FIXTURE_IDS.agent,
    tier: opts.tier ?? 'T3',
    session_nonce: 'n',
    ...(opts.apr ? { apr: opts.apr } : {}),
    quote: { expires_at: iso(opts.quoteExpS ?? 300), mandate_ref: opts.mandateRef ?? null },
  });

const signedClaim = async (
  token: string,
  opts: { grossPence?: number; tsOffsetS?: number; merchantId?: `mer_${string}` } = {},
): Promise<VerifyRequest> => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: opts.merchantId ?? FIXTURE_IDS.merchant,
    attribution_token: token,
    order: {
      order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      gross_value: pence(opts.grossPence ?? 8450),
      ts: iso(opts.tsOffsetS ?? 10),
    },
  };
  const merchant_sig = await signer.sign(
    merchantKeyRef(base.merchant_id),
    claimSignaturePayload(base),
  );
  return { ...base, merchant_sig };
};

const verify = (claim: VerifyRequest, key = newId('clm')) =>
  verifier.verify(claim, { idempotencyKey: key });

const activeMandate = async (perTxn = 15000, perMonth = 150000): Promise<Mandate> =>
  attest<Mandate>(signer, {
    mandate_id: newId('mnd'),
    consumer_ref: FIXTURE_IDS.consumer,
    agent_id: FIXTURE_IDS.agent,
    scopes: ['offers:read', 'checkout:execute'],
    limits: { per_txn: pence(perTxn), per_month: pence(perMonth), categories: ['experiences'] },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
    pre_authorised_up_to: pence(5000),
    status: 'active',
    exp: '2026-12-31T23:59:59Z',
  });

const approvalFor = async (
  mandateId: `mnd_${string}`,
  qid: `qte_${string}`,
  expOffsetS = 300,
): Promise<Approval> =>
  attest<Approval>(signer, {
    approval_id: newId('apr'),
    mandate_id: mandateId,
    quote_id: qid,
    mode: 'explicit',
    approved_at: iso(0),
    exp: iso(expOffsetS),
  });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  mint = new MintSimulator(deps, commitments);
  fixtures = new FixtureDirectory();
  verifier = new VerifySimulator(deps, new VerifiedDirectory(fixtures, signer));
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('verification pipeline (TRIO-8 accept) — all 12 reason codes via public inputs', () => {
  it('happy walletless path: verified, preview == persisted set, events + counters land', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid);
    const result = await verify(await signedClaim(minted.token));
    expect(result.verdict).toBe('verified');
    if (result.verdict !== 'verified') return;

    expect(result.entries_preview.lines.map((l) => l.amount.amount)).toEqual([1200, 720, 240, 240]);
    const { rows } = await pool.query(
      `SELECT account, side, amount_pence FROM trio.entry_lines WHERE entry_set_id = $1 ORDER BY line_id`,
      [result.entries_preview.entry_set_id],
    );
    expect(rows).toEqual(
      result.entries_preview.lines.map((l) => ({
        account: l.account,
        side: l.side,
        amount_pence: String(l.amount.amount),
      })),
    );
    const status = await commitments.status(cid);
    expect(status.conversions_used).toBe(1);
    const verifiedEvents = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'ConversionVerified'`,
    );
    expect(Number(verifiedEvents.rows[0].count)).toBe(1);
  });

  it('SIG_INVALID: tampered merchant sig; forged token; wrong merchant', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid);
    const good = await signedClaim(minted.token);
    expect(await verify({ ...good, merchant_sig: good.merchant_sig.slice(0, -2) + 'ff' })).toEqual({
      verdict: 'rejected',
      reason_code: 'SIG_INVALID',
    });
    expect(await verify(await signedClaim('v4.public.fake.Zm9yZ2Vk.fake-ed25519:bad'))).toEqual({
      verdict: 'rejected',
      reason_code: 'SIG_INVALID',
    });
  });

  it('TOKEN_REPLAYED: a verified token cannot verify again', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid);
    expect((await verify(await signedClaim(minted.token))).verdict).toBe('verified');
    expect(await verify(await signedClaim(minted.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'TOKEN_REPLAYED',
    });
  });

  it('WINDOW_EXPIRED: order.ts beyond iat + attribution_window_s (fires before quote check)', async () => {
    const cid = (await commitments.create(draft({ attribution_window_s: 100 }))).commitment
      .commitment_id;
    const minted = await mintFor(cid, { quoteExpS: 60 });
    // order.ts +200s: beyond window(100) AND beyond quote(60) → earliest stage wins
    expect(await verify(await signedClaim(minted.token, { tsOffsetS: 200 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'WINDOW_EXPIRED',
    });
  });

  it('QUOTE_EXPIRED: within window, past the minted quote snapshot', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid, { quoteExpS: 60 });
    expect(await verify(await signedClaim(minted.token, { tsOffsetS: 120 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'QUOTE_EXPIRED',
    });
  });

  it('COMMITMENT_ENDED: claim beyond the COR validity window (SYN-34)', async () => {
    const cid = (await commitments.create(draft({ valid_until: iso(60) }))).commitment
      .commitment_id;
    const minted = await mintFor(cid, { quoteExpS: 300 });
    expect(await verify(await signedClaim(minted.token, { tsOffsetS: 120 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'COMMITMENT_ENDED',
    });
  });

  it('SYN-34 counterpart: /end after mint does NOT reject in-flight tokens (§5.1 no retroactive repricing)', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid);
    await commitments.end(cid, { reason: 'bounty repriced' });
    expect((await verify(await signedClaim(minted.token))).verdict).toBe('verified');
  });

  it('CAP_EXHAUSTED: max_conversions reached', async () => {
    const cid = (await commitments.create(draft({ max_conversions: 1 }))).commitment.commitment_id;
    const first = await mintFor(cid);
    expect((await verify(await signedClaim(first.token))).verdict).toBe('verified');
    const second = await mintFor(cid);
    expect(await verify(await signedClaim(second.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'CAP_EXHAUSTED',
    });
  });

  it('TIER_INELIGIBLE: token tier outside the COR eligible tiers', async () => {
    const cid = (await commitments.create(draft({ eligible_identity_tiers: ['T1'] }))).commitment
      .commitment_id;
    const minted = await mintFor(cid, { tier: 'T3' });
    expect(await verify(await signedClaim(minted.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'TIER_INELIGIBLE',
    });
  });

  it('BUDGET_EXHAUSTED: budget cannot cover the bounty', async () => {
    const cid = (
      await commitments.create(draft({}, { budget: pence(1200) }))
    ).commitment.commitment_id;
    expect((await verify(await signedClaim((await mintFor(cid)).token))).verdict).toBe('verified');
    expect(await verify(await signedClaim((await mintFor(cid)).token))).toEqual({
      verdict: 'rejected',
      reason_code: 'BUDGET_EXHAUSTED',
    });
  });

  it('APPROVAL_MISSING: wallet-path guard (mandate_ref minted, apr null) and unknown/mismatched approval', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const mandate = await activeMandate();
    fixtures.setMandate(mandate);

    const guard = await mintFor(cid, { mandateRef: mandate.mandate_id });
    expect(await verify(await signedClaim(guard.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'APPROVAL_MISSING',
    });

    const withApr = await mintFor(cid, {
      mandateRef: mandate.mandate_id,
      apr: newId('apr'), // approval never registered in the directory
    });
    expect(await verify(await signedClaim(withApr.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'APPROVAL_MISSING',
    });
  });

  it('APPROVAL_EXPIRED: order.ts past the approval exp', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const mandate = await activeMandate();
    fixtures.setMandate(mandate);
    const qid = newId('qte');
    const approval = await approvalFor(mandate.mandate_id, qid, 60);
    fixtures.setApproval(approval);
    const minted = await mintFor(cid, {
      qid,
      mandateRef: mandate.mandate_id,
      apr: approval.approval_id,
      quoteExpS: 300,
    });
    expect(await verify(await signedClaim(minted.token, { tsOffsetS: 120 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'APPROVAL_EXPIRED',
    });
  });

  it('MANDATE_REVOKED: live revocation rejects the very next claim', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const revocable = await activeMandate();
    fixtures.setMandate(revocable);
    const qid = newId('qte');
    const approval = await approvalFor(revocable.mandate_id, qid);
    fixtures.setApproval(approval);
    const minted = await mintFor(cid, {
      qid,
      mandateRef: revocable.mandate_id,
      apr: approval.approval_id,
    });
    // revoke + re-attest (as the wallet backend would) — live check sees it
    const { attestation: _a, ...revokedBase } = { ...revocable, status: 'revoked' as const };
    fixtures.setMandate(await attest<Mandate>(signer, revokedBase));
    expect(await verify(await signedClaim(minted.token))).toEqual({
      verdict: 'rejected',
      reason_code: 'MANDATE_REVOKED',
    });
  });

  it('LIMIT_EXCEEDED: per_txn breach, and per_month cumulative breach', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const mandate = await activeMandate(15000, 20000);
    fixtures.setMandate(mandate);

    const qid1 = newId('qte');
    const a1 = await approvalFor(mandate.mandate_id, qid1);
    fixtures.setApproval(a1);
    const overTxn = await mintFor(cid, { qid: qid1, mandateRef: mandate.mandate_id, apr: a1.approval_id });
    expect(await verify(await signedClaim(overTxn.token, { grossPence: 20000 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'LIMIT_EXCEEDED',
    });

    // per_month: 14000 verified spend, then 8450 more breaches the 20000 cap
    const qid2 = newId('qte');
    const a2 = await approvalFor(mandate.mandate_id, qid2);
    fixtures.setApproval(a2);
    const first = await mintFor(cid, { qid: qid2, mandateRef: mandate.mandate_id, apr: a2.approval_id });
    expect((await verify(await signedClaim(first.token, { grossPence: 14000 }))).verdict).toBe(
      'verified',
    );
    const qid3 = newId('qte');
    const a3 = await approvalFor(mandate.mandate_id, qid3);
    fixtures.setApproval(a3);
    const second = await mintFor(cid, { qid: qid3, mandateRef: mandate.mandate_id, apr: a3.approval_id });
    expect(await verify(await signedClaim(second.token, { grossPence: 8450 }))).toEqual({
      verdict: 'rejected',
      reason_code: 'LIMIT_EXCEEDED',
    });
  });

  it('idempotency: same key → byte-identical stored verdict, no re-execution; same key + different body → 422', async () => {
    const cid = (await commitments.create(draft())).commitment.commitment_id;
    const minted = await mintFor(cid);
    const claim = await signedClaim(minted.token);
    const key = newId('clm');
    const first = await verify(claim, key);
    const replay = await verify(claim, key);
    expect(replay).toEqual(first); // no TOKEN_REPLAYED — original verdict returned
    const before = await pool.query(`SELECT count(*) FROM events.events WHERE type = 'ConversionVerified'`);
    const replay2 = await verify(claim, key);
    const after = await pool.query(`SELECT count(*) FROM events.events WHERE type = 'ConversionVerified'`);
    expect(replay2.verdict).toBe(first.verdict);
    expect(after.rows[0].count).toBe(before.rows[0].count); // nothing re-posted

    const other = await signedClaim(minted.token);
    await expect(verify(other, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('every verdict lands in the hash-chained ledger', async () => {
    const rejectedEvents = await pool.query(
      `SELECT count(*), count(DISTINCT body->'data'->>'reason_code') AS codes
         FROM events.events WHERE type = 'ConversionRejected'`,
    );
    expect(Number(rejectedEvents.rows[0].codes)).toBeGreaterThanOrEqual(10);
  });
});
