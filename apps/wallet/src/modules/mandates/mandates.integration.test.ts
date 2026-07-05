import { newId, type MandateGrantRequest } from '@merited/contracts';
import { verifyChain } from '@merited/events';
import { FakeSigner } from '@merited/signing';
import { type FastifyInstance } from 'fastify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../lib/mailer/smtp.js';
import { buildWalletServer } from '../../server.js';
import { MandateService } from './mandate-service.js';

/**
 * PH1-16 accept (§6.1): grant/attenuate/revoke; attenuation never widens; a
 * mid-session revocation fails the next checkout with MANDATE_REVOKED; a quote
 * at/below pre_authorised_up_to records an implicit approval, above it →
 * APPROVAL_MISSING; MandateGranted/MandateRevoked land in the hash chain.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_mandates_${Date.now().toString(36)}`;
const money = (amount: number) => ({ amount, currency: 'GBP_pence' as const });
const iso = (days: number): string => new Date(Date.UTC(2026, 6, 5) + days * 86_400_000).toISOString();

let admin: pg.Client;
let pool: pg.Pool;
let mandates: MandateService;
let consumerRef: string;
const agentId = newId('agt');

const grantReq = (): MandateGrantRequest => ({
  agent_id: agentId,
  scopes: ['offers:read', 'checkout:execute'],
  limits: { per_txn: money(5000), per_month: money(20000), categories: ['spa', 'dining'] },
  merchants: ['mer_a', '*'],
  data_sharing: { email: true, purchase_history: false, loyalty_ids: false },
  pre_authorised_up_to: money(2000),
  exp: iso(30),
});

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const migrateUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(migrateUrl);
  await migrateWallet(migrateUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  consumerRef = newId('usr');
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'mandate@test.co.uk')`, [consumerRef]);
  mandates = new MandateService({ pool, signer: new FakeSigner('mandate-test'), clock: { now: () => new Date() } });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('consent & mandate service (PH1-16)', () => {
  it('grant → active mandate signed by the platform + MandateGranted in the ledger', async () => {
    const mandate = await mandates.grant({ consumerRef, request: grantReq() });
    expect(mandate.status).toBe('active');
    expect(mandate.mandate_id).toMatch(/^mnd_/);
    expect(mandate.attestation).toMatch(/^fake-ed25519:/); // platform-attested (FakeSigner in dev)
    const inLedger = await pool.query(
      `SELECT 1 FROM events.events WHERE type = 'MandateGranted' AND body->'data'->'mandate'->>'mandate_id' = $1`,
      [mandate.mandate_id],
    );
    expect(inLedger.rowCount).toBe(1);
  });

  it('attenuate → a narrower CHILD referencing its parent; widening is rejected', async () => {
    const parent = await mandates.grant({ consumerRef, request: grantReq() });
    const child = await mandates.attenuate({
      consumerRef,
      parentId: parent.mandate_id,
      patch: { limits: { per_txn: money(3000) }, pre_authorised_up_to: money(1000), merchants: ['mer_a'] },
    });
    expect(child.limits.per_txn.amount).toBe(3000);
    expect(child.pre_authorised_up_to.amount).toBe(1000);
    const { rows } = await pool.query<{ parent_id: string }>(
      `SELECT parent_id FROM wallet.mandates WHERE mandate_id = $1`,
      [child.mandate_id],
    );
    expect(rows[0]!.parent_id).toBe(parent.mandate_id);

    // widening any limit is refused by construction
    await expect(
      mandates.attenuate({ consumerRef, parentId: parent.mandate_id, patch: { limits: { per_txn: money(9000) } } }),
    ).rejects.toThrow(/widen/);
  });

  it('pre-authorised: a quote ≤ pre_authorised_up_to records an implicit approval (idempotent)', async () => {
    const mandate = await mandates.grant({ consumerRef, request: grantReq() });
    const quoteId = newId('qte');
    const result = await mandates.authoriseForQuote({
      mandateId: mandate.mandate_id,
      quoteId,
      orderValue: money(1500), // ≤ 2000
      quoteExpiresAt: iso(1),
    });
    expect(result.outcome).toBe('pre_authorised');
    if (result.outcome !== 'pre_authorised') throw new Error('unreachable');
    expect(result.approval.mode).toBe('pre_authorised');
    expect(result.approval.quote_id).toBe(quoteId);
    // nothing transacts without an approval OBJECT: it is persisted + in the ledger
    const granted = await pool.query(
      `SELECT 1 FROM events.events WHERE type = 'ApprovalGranted' AND body->'data'->'approval'->>'quote_id' = $1`,
      [quoteId],
    );
    expect(granted.rowCount).toBe(1);

    // idempotent: a second authorise for the same quote reuses the approval
    const again = await mandates.authoriseForQuote({
      mandateId: mandate.mandate_id,
      quoteId,
      orderValue: money(1500),
      quoteExpiresAt: iso(1),
    });
    expect(again.outcome).toBe('pre_authorised');
    const count = await pool.query(`SELECT count(*)::int AS n FROM wallet.approvals WHERE quote_id = $1`, [quoteId]);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('a quote ABOVE pre_authorised_up_to without an explicit approval → APPROVAL_MISSING', async () => {
    const mandate = await mandates.grant({ consumerRef, request: grantReq() });
    const result = await mandates.authoriseForQuote({
      mandateId: mandate.mandate_id,
      quoteId: newId('qte'),
      orderValue: money(3000), // > 2000 pre-auth, ≤ 5000 per_txn
      quoteExpiresAt: iso(1),
    });
    expect(result.outcome).toBe('APPROVAL_MISSING');
  });

  it('a quote above the per_txn limit → LIMIT_EXCEEDED', async () => {
    const mandate = await mandates.grant({ consumerRef, request: grantReq() });
    const result = await mandates.authoriseForQuote({
      mandateId: mandate.mandate_id,
      quoteId: newId('qte'),
      orderValue: money(6000), // > 5000 per_txn
      quoteExpiresAt: iso(1),
    });
    expect(result.outcome).toBe('LIMIT_EXCEEDED');
  });

  it('revocation mid-session → the next checkout attempt fails with MANDATE_REVOKED (live, no cache)', async () => {
    const mandate = await mandates.grant({ consumerRef, request: grantReq() });
    // a pre-authorised checkout succeeds while active
    expect(
      (await mandates.authoriseForQuote({ mandateId: mandate.mandate_id, quoteId: newId('qte'), orderValue: money(1000), quoteExpiresAt: iso(1) })).outcome,
    ).toBe('pre_authorised');

    // the consumer revokes mid-session
    expect(await mandates.revoke({ mandateId: mandate.mandate_id })).toBe(true);
    const status = await pool.query<{ status: string }>(`SELECT status FROM wallet.mandates WHERE mandate_id = $1`, [mandate.mandate_id]);
    expect(status.rows[0]!.status).toBe('revoked'); // LIVE flip
    const revokedEvent = await pool.query(
      `SELECT 1 FROM events.events WHERE type = 'MandateRevoked' AND body->'data'->>'mandate_id' = $1`,
      [mandate.mandate_id],
    );
    expect(revokedEvent.rowCount).toBe(1);

    // the very next checkout attempt fails — no cached authority
    const afterRevoke = await mandates.authoriseForQuote({
      mandateId: mandate.mandate_id,
      quoteId: newId('qte'),
      orderValue: money(1000),
      quoteExpiresAt: iso(1),
    });
    expect(afterRevoke.outcome).toBe('MANDATE_REVOKED');

    // revoke is idempotent
    expect(await mandates.revoke({ mandateId: mandate.mandate_id })).toBe(false);
  });

  it('the hash chain verifies over all mandate/approval events', async () => {
    const client = await pool.connect();
    try {
      expect((await verifyChain(client)).ok).toBe(true);
    } finally {
      client.release();
    }
  });
});

describe('mandate routes require a session (PH1-16, authn on every route)', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildWalletServer({
      pool,
      mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
      sessionSecret: 'mandate-route-secret',
      verifyBaseUrl: 'https://wallet.merited.test/verify',
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('no cookie → 401 on grant, attenuate, revoke', async () => {
    expect((await fetch(`${baseUrl}/v1/mandates`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/mandates/mnd_x/attenuate`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/mandates/mnd_x/revoke`, { method: 'POST' })).status).toBe(401);
  });

  it('no cookie → 401 on approve and decline (PH1-18 routes)', async () => {
    expect((await fetch(`${baseUrl}/v1/quotes/qte_x/approve`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/quotes/qte_x/decline`, { method: 'POST' })).status).toBe(401);
  });
});
