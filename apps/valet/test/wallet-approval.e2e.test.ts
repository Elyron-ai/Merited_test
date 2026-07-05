import { createServer } from 'node:http';
import { newId, pence, type MandateGrantRequest, type VerifyRequest } from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { TrioTokenClient } from '@merited/core';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeShop } from '@merited/fake-aurora';
import { HttpDirectory } from '@merited/trio';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { CapturingPushTransport } from '@merited/wallet';
import { FakeSigner } from '@merited/signing';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../wallet/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../scripts/migrate.mjs';
import { buildWalletServer } from '../../wallet/src/server.js';
import { SmtpMailer } from '../../wallet/src/lib/mailer/smtp.js';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';
import { ErrandDriver } from '../src/errand/driver.js';
import { EventsPackageMirror } from '../src/errand/ledger-mirror.js';
import { ErrandStore } from '../src/errand/store.js';
import { WalletApprovalGate } from '../src/ports/approval-gate.js';
import { FakeShopRail, shopCatalogueSkuResolver } from '../src/ports/checkout-rail.js';
import { PostgresCredentialsStore } from '../src/ports/credentials.js';
import { QuoteClient } from '../src/ports/quote-client.js';
import { VerdictPoller } from '../src/ports/verdict-poller.js';

/**
 * PH2-4 (B17 Valet full) accepts, end-to-end on the live stack — trio with
 * the TRIO-17 HttpDirectory against the wallet, core, FakeShop, wallet with
 * push capture, and the valet driver behind the REAL WalletApprovalGate:
 *  - §6.6: wallet-driven brief with the mandate in consumer_ctx;
 *    AWAITING_APPROVAL live (pre-auth skips it, implicit Approval recorded);
 *    the notification/approval loop rides PH1-17/PH1-18; the re-minted
 *    `apr` token is carried to checkout; kill/restart resumes.
 *  - §6.1: mid-session revocation → the next checkout fails MANDATE_REVOKED.
 *  - §6.4: execute-without-approval → APPROVAL_MISSING; over-limit with a
 *    valid approval → LIMIT_EXCEEDED.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_ph24_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'ph24-service-token';
const DIRECTORY_TOKEN = 'ph24-directory-token';
const SIGNER_SECRET = 'trio-test-secret';
// ONE platform signer identity: wallet attests, trio verifies (SYN-32 fake)
const signer = new FakeSigner(SIGNER_SECRET);

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let valetPool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let core: SimulatedCore;
let shop: FastifyInstance;
let wallet: FastifyInstance;
let walletUrl: string;
let cookie: string;
let driver: ErrandDriver;
let quotes: QuoteClient;
let rail: FakeShopRail;
let pushCapture: CapturingPushTransport;
let merchantId: string;
let resolveSku: (brief: import('@merited/contracts').Brief) => Promise<string | null>;

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const grantMandate = async (overrides: Partial<MandateGrantRequest> = {}): Promise<`mnd_${string}`> => {
  const agent = await quotes.ensureRegistered();
  const body: MandateGrantRequest = {
    agent_id: agent.agent_id,
    scopes: ['offers:read', 'checkout:execute'],
    limits: { per_txn: pence(10000), per_month: pence(50000), categories: ['experiences'] },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
    pre_authorised_up_to: pence(2000), // £20 — the seeded quotes cost more
    exp: iso(30 * 86400),
    ...overrides,
  };
  const response = await fetch(`${walletUrl}/v1/mandates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { mandate: { mandate_id: `mnd_${string}` } };
  return json.mandate.mandate_id;
};

const mirroredTrail = async (errandId: string): Promise<Array<{ from_state: string; to_state: string }>> => {
  const { rows } = await pool.query<{ from_state: string; to_state: string }>(
    `SELECT body->'data'->>'from' AS from_state, body->'data'->>'to' AS to_state
       FROM events.events
      WHERE type = 'ErrandStateChanged' AND body->'data'->>'errand_id' = $1
      ORDER BY seq`,
    [errandId],
  );
  return rows;
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
  await migrateValet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  valetPool = new pg.Pool({
    connectionString: `postgres://merited_valet:merited_valet_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  valetPool.on('error', () => {});

  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });

  // trio resolves consent artefacts LIVE from the wallet (TRIO-17)
  const walletPort = await freePort();
  walletUrl = `http://127.0.0.1:${walletPort}`;
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
    directory: new HttpDirectory({ baseUrl: walletUrl, serviceToken: DIRECTORY_TOKEN }),
  });
  trioUrl = await trio.listen();

  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();

  pushCapture = new CapturingPushTransport();
  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  wallet = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'ph24-session',
    verifyBaseUrl: `${walletUrl}/verify`,
    signer,
    directoryServiceToken: DIRECTORY_TOKEN,
    pushTransport: pushCapture,
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
  });
  await wallet.listen({ port: walletPort, host: '127.0.0.1' });

  const merchant = (await core.merchants.list())[0]!;
  merchantId = merchant.merchant_id;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  quotes = new QuoteClient({
    baseUrl: coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet',
    contact: 'valet@example.test',
  });
  rail = new FakeShopRail(shopUrl);
  resolveSku = shopCatalogueSkuResolver(shopUrl);
  driver = new ErrandDriver({
    store: new ErrandStore(pool),
    mirror: new EventsPackageMirror(valetPool),
    quotes,
    rail,
    gate: new WalletApprovalGate({ walletBaseUrl: walletUrl }),
    poller: new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }),
    resolveSku,
  });

  // consumer session (magic link via mailpit) + a push subscription
  const email = 'ph24@example.co.uk';
  await fetch(`${walletUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const magicToken = new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: magicToken }),
  });
  cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  await fetch(`${walletUrl}/v1/push/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      endpoint: 'https://push.example.test/ph24-device',
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    }),
  });
}, 180_000);

afterAll(async () => {
  await shop.close();
  await wallet.close();
  await core.close();
  await trio.close();
  await valetPool.end();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-4: the live approval loop (§6.6)', () => {
  it('explicit path: push → park → KILL/RESTART → approve → re-minted apr token to checkout → CONFIRMED', async () => {
    const mandateId = await grantMandate(); // pre-auth £20 < quote → explicit
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });

    // drive parks the errand awaiting the consumer
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');
    const originalToken = parked.errand.token!;
    expect(originalToken).toBeTruthy();

    // PH1-17's production caller fired: the phone got the approve push
    expect(pushCapture.deliveries.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(pushCapture.deliveries.at(-1)!.payload) as {
      quote: { quote_id: string };
      deep_link: string;
    };
    expect(payload.quote.quote_id).toBe(parked.errand.quote_id);
    expect(payload.deep_link).toContain(parked.errand.quote_id);

    // §6.6 kill/restart: a FRESH driver over the same database resumes and
    // stays parked — no duplicate side effects, no lost state
    const restarted = new ErrandDriver({
      store: new ErrandStore(pool),
      mirror: new EventsPackageMirror(valetPool),
      quotes,
      rail,
      gate: new WalletApprovalGate({ walletBaseUrl: walletUrl }),
      poller: new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }),
      resolveSku,
    });
    const resumed = await restarted.resumeAll();
    expect(resumed.find((e) => e.errand.errand_id === started.errand.errand_id)!.state).toBe(
      'AWAITING_APPROVAL',
    );

    // the consumer approves on their phone (PH1-18, idempotency-keyed)
    const approve = await fetch(`${walletUrl}/v1/quotes/${parked.errand.quote_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'idempotency-key': newId('apr') },
      body: JSON.stringify({ mandate_id: mandateId }),
    });
    expect(approve.status).toBe(200);

    // the restarted driver picks the decision up and completes the errand
    const finished = await restarted.drive(started.errand.errand_id);
    expect(finished.state).toBe('CONFIRMED');
    expect(finished.errand.approval_id).toMatch(/^apr_/);
    // the RE-MINTED token went to checkout — same qid, fresh jti (§6.4/§7.2)
    expect(finished.errand.token).not.toBe(originalToken);
    expect(finished.errand.claim_id).toMatch(/^clm_/);

    // §6.6: every transition from QUOTED onward is a ledger fact
    const trail = await mirroredTrail(started.errand.errand_id);
    expect(trail).toEqual([
      { from_state: 'SEARCHING', to_state: 'QUOTED' },
      { from_state: 'QUOTED', to_state: 'AWAITING_APPROVAL' },
      { from_state: 'AWAITING_APPROVAL', to_state: 'APPROVED' },
      { from_state: 'APPROVED', to_state: 'EXECUTING' },
      { from_state: 'EXECUTING', to_state: 'CONFIRMED' },
    ]);
  });

  it('pre-authorised path: quote ≤ pre_authorised_up_to skips AWAITING_APPROVAL; the implicit Approval is RECORDED', async () => {
    const mandateId = await grantMandate({ pre_authorised_up_to: pence(10000) }); // £100 ≥ quote
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });
    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('CONFIRMED');
    expect(finished.errand.approval_id).toMatch(/^apr_/);

    // implicit ≠ invisible: the Approval row exists with mode pre_authorised
    const { rows } = await pool.query(
      `SELECT mode FROM wallet.approvals WHERE approval_id = $1`,
      [finished.errand.approval_id],
    );
    expect(rows).toEqual([{ mode: 'pre_authorised' }]);

    // and the errand NEVER entered AWAITING_APPROVAL
    const trail = await mirroredTrail(started.errand.errand_id);
    expect(trail.map((t) => t.to_state)).not.toContain('AWAITING_APPROVAL');
    expect(trail.map((t) => t.to_state)).toContain('CONFIRMED');
  });

  it('decline path: the consumer says no → DECLINED, nothing bought', async () => {
    const mandateId = await grantMandate();
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');

    await fetch(`${walletUrl}/v1/quotes/${parked.errand.quote_id}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mandate_id: mandateId }),
    });

    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('DECLINED');
    expect(finished.errand.claim_id).toBeNull(); // nothing bought
  });
});

describe('PH2-4: negatives on real rails (§6.1/§6.4)', () => {
  it('§6.4: execute WITHOUT approval — the pre-approval token dies APPROVAL_MISSING at verify', async () => {
    const mandateId = await grantMandate();
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');

    // a rogue execution path checks out with the ORIGINAL (apr-less) token
    await rail.checkout({
      sku: 'sku_spa_day',
      attribution_token: parked.errand.token,
      errand_id: parked.errand.errand_id as `ern_${string}`,
    });
    const claim = await new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }).poll(
      parked.errand.quote_id!,
    );
    expect(claim).toEqual({ type: 'CLAIM_REJECTED', reason_code: 'APPROVAL_MISSING' });
  });

  it('§6.4: over-limit — approval against a mandate the order value breaches → LIMIT_EXCEEDED', async () => {
    // per-txn £30 < the £71.83 quote: the wallet REFUSES to approve
    const mandateId = await grantMandate({ limits: { per_txn: pence(3000), per_month: pence(50000), categories: ['experiences'] } });
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');

    const approve = await fetch(`${walletUrl}/v1/quotes/${parked.errand.quote_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mandate_id: mandateId }),
    });
    expect(approve.status).toBe(409);
    expect(((await approve.json()) as { error: { code: string } }).error.code).toBe('LIMIT_EXCEEDED');

    // and an apr-bearing claim whose ORDER breaches the mandate dies at the
    // trio with LIMIT_EXCEEDED (§3's reason table, proven on the live stack)
    const okMandate = await grantMandate({ pre_authorised_up_to: pence(10000) });
    const approvedRun = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: okMandate,
    });
    // step to APPROVED so the re-minted token exists but nothing is bought yet
    let stored = await driver.step(approvedRun.errand.errand_id); // SEARCHING
    stored = await driver.step(approvedRun.errand.errand_id); // QUOTED
    stored = await driver.step(approvedRun.errand.errand_id); // → APPROVED (pre-auth)
    expect(stored!.state).toBe('APPROVED');
    const base = {
      claim_id: newId('clm'),
      merchant_id: merchantId,
      attribution_token: stored!.errand.token!,
      order: { order_ref_hash: 'c'.repeat(64), gross_value: pence(60000), ts: iso(5) }, // £600 ≫ per_txn £100
    };
    const merchant_sig = await signer.sign(`merchant/${merchantId}`, canonicalJson(base));
    const verdict = await (
      await fetch(`${trioUrl}/trio/claims/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-merited-service-token': SERVICE_TOKEN,
          'idempotency-key': newId('clm'),
        },
        body: JSON.stringify({ ...base, merchant_sig } as VerifyRequest),
      })
    ).json() as { verdict: string; reason_code?: string };
    expect(verdict).toEqual({ verdict: 'rejected', reason_code: 'LIMIT_EXCEEDED' });
  });

  it('§6.1: mid-session revocation — the NEXT checkout fails MANDATE_REVOKED and the errand lands FAILED', async () => {
    const mandateId = await grantMandate({ pre_authorised_up_to: pence(10000) });
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId,
    });
    // approve implicitly (pre-auth), stop before execution
    let stored = await driver.step(started.errand.errand_id); // SEARCHING
    stored = await driver.step(started.errand.errand_id); // QUOTED
    stored = await driver.step(started.errand.errand_id); // APPROVED
    expect(stored!.state).toBe('APPROVED');

    // the consumer revokes RIGHT NOW — the approval and token already exist
    await fetch(`${walletUrl}/v1/mandates/${mandateId}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });

    // next checkout: the trio re-reads the mandate LIVE via the directory
    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('FAILED');
    const log = await new ErrandStore(pool).eventLog(started.errand.errand_id);
    const rejection = log.find((row) => row.event.type === 'CLAIM_REJECTED');
    expect(rejection?.event).toEqual({ type: 'CLAIM_REJECTED', reason_code: 'MANDATE_REVOKED' });
  });
});
