import {
  FIXTURE_IDS,
  newId,
  pence,
  type CommitmentDraft,
  type MandateGrantRequest,
  type VerifyRequest,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { TrioCommitmentsClient, TrioTokenClient } from '@merited/core';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { FakeSigner } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../scripts/migrate.mjs';
import { MandateService } from '../mandates/mandate-service.js';
import { ApprovalsService, PgQuoteReader } from './approvals.js';

/**
 * PH1-18 accept — all four §6.4 verbatim targets AGAINST THE SIMULATOR, with
 * every consent artefact produced by the REAL wallet services:
 *   1. approve-then-execute within quote TTL verifies end-to-end
 *   2. execute-without-approval on a wallet-path claim → APPROVAL_MISSING
 *   3. approval after quote expiry → APPROVAL_EXPIRED
 *   4. order value above mandate limit with valid approval → LIMIT_EXCEEDED
 * Plus: approval single-use (a second claim on the same apr rejects) and
 * ApprovalGranted/ApprovalDeclined in the hash-chained ledger.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_apr_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'b26-e2e-token';
const SIGNER_SECRET = 'b26-e2e-secret';
// ONE platform signer identity across wallet and trio — the trio verifies
// wallet attestations before trusting them (VerifiedDirectory).
const signer = new FakeSigner(SIGNER_SECRET);

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let mandateService: MandateService;
let approvals: ApprovalsService;
let tokenClient: TrioTokenClient;
let commitmentId: `com_${string}`;
let consumerRef: string;

const grantReq = (): MandateGrantRequest => ({
  agent_id: FIXTURE_IDS.agent,
  scopes: ['offers:read', 'checkout:execute'],
  limits: { per_txn: pence(10000), per_month: pence(50000), categories: ['experiences'] },
  merchants: ['*'],
  data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
  pre_authorised_up_to: pence(2000),
  exp: iso(30 * 86400),
});

/** Insert a core.quotes fixture row — the wallet's quote-liveness source. */
const insertQuote = async (opts: { finalPence?: number; expiresInS?: number } = {}): Promise<string> => {
  const quoteId = newId('qte');
  await pool.query(
    `INSERT INTO core.quotes
       (quote_id, offer_id, commitment_id, agent_id, consumer_ref, tier, segment,
        list_amount, final_amount, currency, mechanics_applied, token_jti,
        expires_at, created_at, inputs_snapshot)
     VALUES ($1,$2,$3,$4,$5,'T1','t1-member-new',$6,$7,'GBP_pence','[]',NULL,$8,now(),'{}')`,
    [
      quoteId,
      FIXTURE_IDS.offer,
      commitmentId,
      FIXTURE_IDS.agent,
      consumerRef,
      8450,
      opts.finalPence ?? 8450,
      iso(opts.expiresInS ?? 300),
    ],
  );
  return quoteId;
};

/** Sign a claim exactly as a merchant webhook would (canonical minus sig). */
const signedClaim = async (
  token: string,
  opts: { grossPence?: number; tsOffsetS?: number } = {},
): Promise<VerifyRequest> => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: FIXTURE_IDS.merchant,
    attribution_token: token,
    order: {
      order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      gross_value: pence(opts.grossPence ?? 8450),
      ts: iso(opts.tsOffsetS ?? 10),
    },
  };
  const merchant_sig = await signer.sign(`merchant/${base.merchant_id}`, canonicalJson(base));
  return { ...base, merchant_sig } as VerifyRequest;
};

const verifyClaim = async (claim: VerifyRequest): Promise<{ verdict: string; reason_code?: string }> => {
  const response = await fetch(`${trioUrl}/trio/claims/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-merited-service-token': SERVICE_TOKEN,
      'idempotency-key': newId('clm'),
    },
    body: JSON.stringify(claim),
  });
  return response.json() as Promise<{ verdict: string; reason_code?: string }>;
};

/** Feed the trio's directory with the WALLET's records (the TRIO-17 seam —
 * in production an HTTP directory reads the wallet backend; the attestation
 * check is identical either way). */
const publishToDirectory = async (mandateId: string, quoteId: string): Promise<void> => {
  const mandate = await mandateService.get(mandateId);
  const approval = await mandateService.approvalFor(quoteId);
  if (mandate) trio.directory.setMandate(mandate);
  if (approval) trio.directory.setApproval(approval);
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateWallet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  trioUrl = await trio.listen();
  tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });

  const commitments = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const draft: CommitmentDraft = {
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
    },
  };
  commitmentId = (await commitments.create(draft)).commitment_id;

  consumerRef = newId('usr');
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'b26@test.co.uk')`, [consumerRef]);
  mandateService = new MandateService({ pool, signer, clock: { now: () => new Date() } });
  approvals = new ApprovalsService({
    pool,
    mandates: mandateService,
    quotes: new PgQuoteReader(pool),
    // the re-mint call goes through CORE's token-client (the task row's seam)
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
    clock: { now: () => new Date() },
  });
}, 120_000);

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('B26 approvals — §6.4 accepts against the simulator (PH1-18)', () => {
  it('(1) approve-then-execute within quote TTL verifies end-to-end', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote();

    const approved = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id });
    expect(approved.outcome).toBe('approved');
    if (approved.outcome !== 'approved') throw new Error('unreachable');
    expect(approved.approval.mode).toBe('explicit');
    expect(approved.approval.quote_id).toBe(quoteId);
    expect(approved.approval.exp).toBe(new Date((await pool.query<{ e: Date }>(
      `SELECT expires_at AS e FROM core.quotes WHERE quote_id = $1`, [quoteId],
    )).rows[0]!.e).toISOString()); // exp = quote.expires_at
    expect(approved.token).toBeTruthy();

    // the re-mint is a WALLET-PATH token: same qid, apr set, mandate snapshot
    const minted = await pool.query<{ qid: string; apr: string | null; mandate_ref: string | null }>(
      `SELECT qid, apr, mandate_ref FROM trio.minted_tokens WHERE apr = $1`,
      [approved.approval.approval_id],
    );
    expect(minted.rows[0]).toEqual({
      qid: quoteId,
      apr: approved.approval.approval_id,
      mandate_ref: mandate.mandate_id,
    });

    // execute: the trio verifies the wallet's attestations before trusting
    await publishToDirectory(mandate.mandate_id, quoteId);
    const verdict = await verifyClaim(await signedClaim(approved.token));
    expect(verdict).toMatchObject({ verdict: 'verified' });

    // single-use apr: a SECOND claim on the same apr (same qid) rejects
    const replay = await verifyClaim(await signedClaim(approved.token));
    expect(replay).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
    // …and even a FRESH re-mint of the same qid cannot convert again (SYN-9)
    const again = await tokenClient.mint({
      cid: commitmentId, qid: quoteId as `qte_${string}`, aid: FIXTURE_IDS.agent, tier: 'T1',
      session_nonce: 'replay-probe', apr: approved.approval.approval_id as `apr_${string}`,
      quote: { expires_at: iso(300), mandate_ref: mandate.mandate_id as `mnd_${string}` },
    });
    if (!again.ok) throw new Error('re-mint probe failed');
    const replayFresh = await verifyClaim(await signedClaim(again.minted.token));
    expect(replayFresh).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
  });

  it('(2) execute-without-approval on a wallet-path claim → APPROVAL_MISSING', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    // a wallet-path token (mandate snapshot set) minted WITHOUT any approval
    const minted = await tokenClient.mint({
      cid: commitmentId, qid: newId('qte'), aid: FIXTURE_IDS.agent, tier: 'T1',
      session_nonce: 'no-approval', quote: { expires_at: iso(300), mandate_ref: mandate.mandate_id as `mnd_${string}` },
    });
    if (!minted.ok) throw new Error('mint failed');
    const verdict = await verifyClaim(await signedClaim(minted.minted.token));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'APPROVAL_MISSING' });
  });

  it('(3) approval after quote expiry → APPROVAL_EXPIRED (and no approval or token is minted)', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote({ expiresInS: -5 }); // already expired
    const before = await pool.query(`SELECT count(*)::int AS n FROM trio.minted_tokens`);

    const result = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id });
    expect(result.outcome).toBe('APPROVAL_EXPIRED');
    expect(await mandateService.approvalFor(quoteId)).toBeNull(); // nothing issued
    const after = await pool.query(`SELECT count(*)::int AS n FROM trio.minted_tokens`);
    expect(after.rows[0]).toEqual(before.rows[0]); // nothing minted
  });

  it('(4) order value above mandate limit WITH a valid approval → LIMIT_EXCEEDED', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote({ finalPence: 9000 }); // within per_txn 10000
    const approved = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id });
    if (approved.outcome !== 'approved') throw new Error('approve failed');
    await publishToDirectory(mandate.mandate_id, quoteId);

    // the CLAIM arrives above the mandate's per_txn limit
    const verdict = await verifyClaim(await signedClaim(approved.token, { grossPence: 12000 }));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'LIMIT_EXCEEDED' });
  });

  it('a revoked mandate fails the claim even with an approval (defence in depth)', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote();
    const approved = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id });
    if (approved.outcome !== 'approved') throw new Error('approve failed');
    await publishToDirectory(mandate.mandate_id, quoteId);
    await mandateService.revoke({ mandateId: mandate.mandate_id });
    trio.directory.revokeMandate(mandate.mandate_id);

    const verdict = await verifyClaim(await signedClaim(approved.token));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'MANDATE_REVOKED' });
    // …and the wallet refuses to approve anything further under it
    const next = await approvals.approve({ consumerRef, quoteId: await insertQuote(), mandateId: mandate.mandate_id });
    expect(next.outcome).toBe('MANDATE_REVOKED');
  });

  it('idempotent under Idempotency-Key: a replay returns the ORIGINAL token, no second mint', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote();
    const key = `idem-${quoteId}`;

    const first = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id, idempotencyKey: key });
    if (first.outcome !== 'approved') throw new Error('approve failed');
    const mintsAfterFirst = await pool.query(`SELECT count(*)::int AS n FROM trio.minted_tokens WHERE qid = $1`, [quoteId]);

    const replay = await approvals.approve({ consumerRef, quoteId, mandateId: mandate.mandate_id, idempotencyKey: key });
    expect(replay).toEqual(first); // the ORIGINAL result, token included
    const mintsAfterReplay = await pool.query(`SELECT count(*)::int AS n FROM trio.minted_tokens WHERE qid = $1`, [quoteId]);
    expect(mintsAfterReplay.rows[0]).toEqual(mintsAfterFirst.rows[0]); // no fresh jti
  });

  it('decline: ApprovalDeclined lands in the ledger and the awaiting errand expires gracefully', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote();
    const errandId = newId('ern');
    await pool.query(
      `INSERT INTO wallet.errands (errand_id, consumer_ref, state, brief)
       VALUES ($1, $2, 'AWAITING_APPROVAL', $3::jsonb)`,
      [errandId, consumerRef, JSON.stringify({ text: 'spa day', quote_id: quoteId })],
    );

    const declined = await approvals.decline({ consumerRef, quoteId, mandateId: mandate.mandate_id });
    expect(declined.declined).toBe(true);
    const event = await pool.query(
      `SELECT 1 FROM events.events WHERE type = 'ApprovalDeclined' AND body->'data'->>'quote_id' = $1`,
      [quoteId],
    );
    expect(event.rowCount).toBe(1);
    const errand = await pool.query<{ state: string }>(`SELECT state FROM wallet.errands WHERE errand_id = $1`, [errandId]);
    expect(errand.rows[0]!.state).toBe('EXPIRED');

    // decline is idempotent — one ApprovalDeclined per quote, ever
    expect((await approvals.decline({ consumerRef, quoteId, mandateId: mandate.mandate_id })).declined).toBe(false);
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM events.events WHERE type = 'ApprovalDeclined' AND body->'data'->>'quote_id' = $1`,
      [quoteId],
    );
    expect((events.rows[0] as { n: number }).n).toBe(1);
  });

  it('ApprovalGranted events landed for every approval and the hash chain verifies', async () => {
    const granted = await pool.query(`SELECT count(*)::int AS n FROM events.events WHERE type = 'ApprovalGranted'`);
    expect((granted.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(4);
    const { verifyChain } = await import('@merited/events');
    const client = await pool.connect();
    try {
      expect((await verifyChain(client)).ok).toBe(true);
    } finally {
      client.release();
    }
  });
});
