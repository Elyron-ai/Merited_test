import {
  FIXTURE_IDS,
  newId,
  pence,
  type CommitmentDraft,
  type MandateGrantRequest,
} from '@merited/contracts';
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
import { ApprovalRequestsService } from './approval-requests.js';

/**
 * Hardening W1 (audit finding #5): `ApprovalRequestsService.create` must
 * bind the quote to the mandate's own agent+consumer. Without it, an
 * unauthenticated caller who learns any quote_id + any mandate_id could force
 * an implicit approval against a DIFFERENT consumer's mandate and receive the
 * convertible re-minted token. These tests prove a cross-tenant pair yields
 * NO approval and NO token, while a correctly-bound pair still approves.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_aprq_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'aprq-e2e-token';
const SIGNER_SECRET = 'aprq-e2e-secret';
const signer = new FakeSigner(SIGNER_SECRET);

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let mandateService: MandateService;
let approvalRequests: ApprovalRequestsService;
let commitmentId: `com_${string}`;
let consumerRef: string;

const grantReq = (agentId: string = FIXTURE_IDS.agent): MandateGrantRequest => ({
  agent_id: agentId as `agt_${string}`,
  scopes: ['offers:read', 'checkout:execute'],
  limits: { per_txn: pence(10000), per_month: pence(50000), categories: ['experiences'] },
  merchants: ['*'],
  data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
  pre_authorised_up_to: pence(2000),
  exp: iso(30 * 86400),
});

/** Insert a core.quotes row with controllable agent_id / consumer_ref. */
const insertQuote = async (opts: {
  agentId?: string;
  consumerRef?: string;
  finalPence?: number;
} = {}): Promise<string> => {
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
      opts.agentId ?? FIXTURE_IDS.agent,
      opts.consumerRef ?? consumerRef,
      2000,
      opts.finalPence ?? 1500, // ≤ pre_authorised_up_to (2000) → implicit path
      iso(300),
    ],
  );
  return quoteId;
};

const approvalRowCount = async (quoteId: string): Promise<number> =>
  (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wallet.approval_requests WHERE quote_id = $1`,
    [quoteId],
  )).rows[0]!.n;

const mintedCount = async (): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trio.minted_tokens`)).rows[0]!.n;

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
  const trioUrl = await trio.listen();
  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });

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
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'aprq@test.co.uk')`, [consumerRef]);
  mandateService = new MandateService({ pool, signer, clock: { now: () => new Date() } });
  const approvals = new ApprovalsService({
    pool,
    mandates: mandateService,
    quotes: new PgQuoteReader(pool),
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
    clock: { now: () => new Date() },
  });
  approvalRequests = new ApprovalRequestsService({
    pool,
    mandates: mandateService,
    approvals,
    quotes: new PgQuoteReader(pool),
    clock: { now: () => new Date() },
  });
}, 120_000);

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('ApprovalRequestsService.create — quote↔mandate binding (W1 / finding #5)', () => {
  it('a correctly-bound pair still approves implicitly and returns the token (regression)', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const quoteId = await insertQuote(); // same agent + consumer, ≤ pre-auth

    const result = await approvalRequests.create({ quoteId, mandateId: mandate.mandate_id });
    expect(result?.status).toBe('approved');
    expect(result?.token).toBeTruthy();
  });

  it('CROSS-AGENT: a quote for a DIFFERENT agent is refused — no approval, no token', async () => {
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    const foreignAgentQuote = await insertQuote({ agentId: newId('agt') }); // victim's mandate, attacker quote
    const before = await mintedCount();

    const result = await approvalRequests.create({ quoteId: foreignAgentQuote, mandateId: mandate.mandate_id });
    expect(result).toBeNull(); // uniform 404 — no cross-tenant authority use
    expect(await approvalRowCount(foreignAgentQuote)).toBe(0); // nothing persisted
    expect(await mandateService.approvalFor(foreignAgentQuote)).toBeNull(); // no Approval recorded
    expect(await mintedCount()).toBe(before); // no token minted
  });

  it('CROSS-CONSUMER: a quote bound to a DIFFERENT consumer is refused — no approval, no token', async () => {
    const otherConsumer = newId('usr');
    await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'other@test.co.uk')`, [otherConsumer]);
    const mandate = await mandateService.grant({ consumerRef, request: grantReq() });
    // same agent as the mandate, but the quote belongs to another consumer
    const foreignConsumerQuote = await insertQuote({ consumerRef: otherConsumer });
    const before = await mintedCount();

    const result = await approvalRequests.create({ quoteId: foreignConsumerQuote, mandateId: mandate.mandate_id });
    expect(result).toBeNull();
    expect(await approvalRowCount(foreignConsumerQuote)).toBe(0);
    expect(await mandateService.approvalFor(foreignConsumerQuote)).toBeNull();
    expect(await mintedCount()).toBe(before);
  });
});
