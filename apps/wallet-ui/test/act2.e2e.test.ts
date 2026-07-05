import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, pence } from '@merited/contracts';
import { catchUp } from '@merited/events';
import { TrioTokenClient } from '@merited/core';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeShop } from '@merited/fake-aurora';
import { HttpDirectory } from '@merited/trio';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { CapturingPushTransport, pointsCreditProjection } from '@merited/wallet';
import { FakeAuroraLoyalty } from '@merited/core';
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
import { migrateValet } from '../../valet/scripts/migrate.mjs';
import { buildWalletServer } from '../../wallet/src/server.js';
import { SmtpMailer } from '../../wallet/src/lib/mailer/smtp.js';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';
import { ErrandDriver } from '../../valet/src/errand/driver.js';
import { EventsPackageMirror } from '../../valet/src/errand/ledger-mirror.js';
import { ErrandStore } from '../../valet/src/errand/store.js';
import { WalletApprovalGate } from '../../valet/src/ports/approval-gate.js';
import { FakeShopRail, shopCatalogueSkuResolver } from '../../valet/src/ports/checkout-rail.js';
import { PostgresCredentialsStore } from '../../valet/src/ports/credentials.js';
import { QuoteClient } from '../../valet/src/ports/quote-client.js';
import { VerdictPoller } from '../../valet/src/ports/verdict-poller.js';

/**
 * PH2-3 ACCEPT: "Every Act 2 on-screen step (§10) is performable through
 * these screens with no CLI assistance except the demo driver." The demo
 * driver briefs the Valet; EVERYTHING the consumer does happens on screen:
 * the pending approval appears on the errand screen, the push deep-link
 * page shows the locked price, the approve click completes the deal, the
 * points land on activity and home. One world: trio (live directory), core,
 * FakeShop, wallet API, the valet driver and the built UI.
 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_act2ui_${Date.now().toString(36)}`;
const UI_PORT = 5950 + Math.floor(Math.random() * 49);
const UI = `http://127.0.0.1:${UI_PORT}`;
const SERVICE_TOKEN = 'act2ui-service';
const DIRECTORY_TOKEN = 'act2ui-directory';
const SIGNER_SECRET = 'trio-test-secret';

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

let admin: pg.Client;
let pool: pg.Pool;
let valetPool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let wallet: FastifyInstance;
let ui: ChildProcess | null = null;
let driver: ErrandDriver;
let cookie = '';
let consumerRef = '';
let mandateId = '';

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const get = async (pathname: string): Promise<string> =>
  (await (await fetch(`${UI}${pathname}`, { headers: { cookie } })).text()).replace(
    /<script[\s\S]*?<\/script>/g,
    '',
  );

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

  const walletPort = await freePort();
  const walletUrl = `http://127.0.0.1:${walletPort}`;
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
    directory: new HttpDirectory({ baseUrl: walletUrl, serviceToken: DIRECTORY_TOKEN }),
  });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();

  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  wallet = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'act2ui-session',
    verifyBaseUrl: `${UI}/verify`,
    signer: new FakeSigner(SIGNER_SECRET),
    directoryServiceToken: DIRECTORY_TOKEN,
    pushTransport: new CapturingPushTransport(),
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
  });
  await wallet.listen({ port: walletPort, host: '127.0.0.1' });

  const merchant = (await core.merchants.list())[0]!;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  const quotes = new QuoteClient({
    baseUrl: coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet',
    contact: 'valet@example.test',
  });
  driver = new ErrandDriver({
    store: new ErrandStore(pool),
    mirror: new EventsPackageMirror(valetPool),
    quotes,
    rail: new FakeShopRail(shopUrl),
    gate: new WalletApprovalGate({ walletBaseUrl: walletUrl }),
    poller: new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }),
    resolveSku: shopCatalogueSkuResolver(shopUrl),
  });

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 300_000 });
  }
  ui = spawn('pnpm', ['exec', 'next', 'start', '-p', String(UI_PORT)], {
    cwd: appRoot,
    env: { ...process.env, MERITED_WALLET_API_URL: walletUrl, MERITED_CORE_API_URL: coreUrl, NODE_ENV: 'production' },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${UI}/login`, { redirect: 'manual' })).status === 200) break;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // consumer session + linked programme (linking proven in its own suites)
  const email = 'act2ui@example.co.uk';
  await fetch(`${UI}/api/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email }).toString(),
    redirect: 'manual',
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const verified = await fetch(full.Text.match(/https?:\/\/\S+/)![0], { redirect: 'manual' });
  cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0]!;
  consumerRef = (
    await pool.query<{ consumer_ref: string }>(`SELECT consumer_ref FROM wallet.consumers WHERE email = $1`, [email])
  ).rows[0]!.consumer_ref;
  await pool.query(
    `INSERT INTO wallet.identity_links (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes)
     VALUES ($1, $2, $3, 'aurora-club', $4, $5, '["loyalty_ids"]'::jsonb)`,
    [newId('lnk'), consumerRef, merchant.merchant_id, gold.member_ref, gold.sub_hash],
  );

  // screen 3: grant the mandate THROUGH THE UI (pre-auth £0 → explicit approvals)
  const agent = await quotes.ensureRegistered();
  await fetch(`${UI}/api/mandates`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      agent_id: agent.agent_id, per_txn_pounds: '100', per_month_pounds: '500',
      pre_auth_pounds: '0', categories: 'experiences', exp_days: '30',
    }).toString(),
    redirect: 'manual',
  });
  mandateId = (
    await pool.query<{ mandate_id: string }>(`SELECT mandate_id FROM wallet.mandates WHERE consumer_ref = $1`, [consumerRef])
  ).rows[0]!.mandate_id;
}, 420_000);

afterAll(async () => {
  ui?.kill('SIGTERM');
  await shop.close();
  await wallet.close();
  await core.close();
  await trio.close();
  await valetPool.end();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-3 ACCEPT: Act 2 on-screen steps, no CLI beyond the demo driver', () => {
  it('brief → park → approve ON SCREEN → deal done → points on activity and home', async () => {
    // the demo driver briefs the Valet (the one allowed off-screen actor)
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId as `mnd_${string}`,
    });
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');
    const qid = parked.errand.quote_id!;

    // screen 5: the pending approval is visible with the locked price
    // the LOCKED price is whatever the quote promised — read it back
    const quoteRow = await pool.query<{ final_amount: number }>(
      `SELECT final_amount::int FROM core.quotes WHERE quote_id = $1`, [qid],
    );
    const finalPence = Number(quoteRow.rows[0]!.final_amount);
    const locked = `£${Math.floor(finalPence / 100)}.${String(finalPence % 100).padStart(2, '0')}`;

    const errandScreen = await get('/errand');
    expect(errandScreen).toContain(`data-pending="${qid}"`);
    expect(errandScreen).toContain(locked);
    expect(errandScreen).toContain('AWAITING_APPROVAL');

    // the push deep-link page: locked price + the decision buttons
    const approvePage = await get(`/approve/${qid}`);
    expect(approvePage).toContain('data-approve-status="pending"');
    expect(approvePage).toContain(locked);
    expect(approvePage).toContain('Approve');

    // the consumer clicks APPROVE — a UI form post, nothing else
    const clicked = await fetch(`${UI}/api/quotes/${qid}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ mandate_id: mandateId }).toString(),
      redirect: 'manual',
    });
    expect(clicked.status).toBe(303);

    // the valet completes the deal on real rails (re-minted apr token)
    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('CONFIRMED');

    // points credit (PH2-10's projection — the production consumer)
    await catchUp(
      pool,
      pointsCreditProjection({
        pool,
        resolveLoyalty: (programme) =>
          programme === 'aurora-club'
            ? new FakeAuroraLoyalty({ baseUrl: 'http://unused.invalid', fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch })
            : null,
      }),
    );

    // screen 5 shows the confirmed trail; screen 6 the credit; screen 1 the balance
    const trail = await get('/errand');
    expect(trail).toContain('data-errand="CONFIRMED"');
    const activity = await get('/activity');
    expect(activity).toContain('data-approval-mode="explicit"');
    expect(activity).toContain('data-credit="aurora-club"');
    const credited = await pool.query<{ points: number }>(
      `SELECT points::int FROM wallet.points_credits WHERE consumer_ref = $1`, [consumerRef],
    );
    const home = await get('/');
    expect(home).toContain(`>${credited.rows[0]!.points}<`); // the credit feed on screen 1
  });

  it('the decline path is equally on-screen: a declined errand ends DECLINED', async () => {
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
      mandate_id: mandateId as `mnd_${string}`,
    });
    const parked = await driver.drive(started.errand.errand_id);
    expect(parked.state).toBe('AWAITING_APPROVAL');
    const qid = parked.errand.quote_id!;

    const clicked = await fetch(`${UI}/api/quotes/${qid}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ mandate_id: mandateId }).toString(),
      redirect: 'manual',
    });
    expect(clicked.status).toBe(303);

    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('DECLINED');
    expect((await get(`/approve/${qid}`))).toContain('already');
  });
});
