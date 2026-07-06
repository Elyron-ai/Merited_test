import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@merited/contracts';
import { FakeAuroraIdpAdapter, IdpRegistry } from '@merited/core';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeAuroraIdp, type FakeAuroraIdp } from '@merited/fake-aurora';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
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
import { buildWalletServer } from '../../wallet/src/server.js';
import { SmtpMailer } from '../../wallet/src/lib/mailer/smtp.js';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';

/**
 * PH2-3 slice 1 (screens 1–3): the UI renders ONLY from the wallet API's
 * session-scoped read models, magic-link auth end-to-end through the UI's
 * own /verify relay, and the revoke/grant actions land through the same
 * public API the tests and demo drive. Screens 4–6 arrive in slice 2.
 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_wui_${Date.now().toString(36)}`;
const UI_PORT = 5850 + Math.floor(Math.random() * 100);
const UI = `http://127.0.0.1:${UI_PORT}`;

const SERVICE_TOKEN = 'wui-service-token';
const SIGNER_SECRET = 'trio-test-secret';
const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let idp: FakeAuroraIdp;
let seededMerchant = '';
let walletApi: FastifyInstance;
let ui: ChildProcess | null = null;
let cookie = '';
let consumerRef = '';

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const get = async (pathname: string): Promise<{ status: number; html: string }> => {
  const response = await fetch(`${UI}${pathname}`, { redirect: 'manual', headers: { cookie } });
  return { status: response.status, html: (await response.text()).replace(/<script[\s\S]*?<\/script>/g, '') };
};

const post = async (pathname: string, form: Record<string, string>): Promise<number> => {
  const response = await fetch(`${UI}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  return response.status;
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

  // screen 4's world: seeded offers on the real trio+core
  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });
  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();
  seededMerchant = (await core.merchants.list())[0]!.merchant_id;

  // wallet API with the magic link pointing at the UI's /verify relay,
  // plus the FakeAurora IdP behind the registry for the link button
  const apiPort = await freePort();
  const idpIssuer = `http://127.0.0.1:${await freePort()}`;
  idp = await createFakeAuroraIdp({ issuer: idpIssuer, clientId: 'wui-client', clientSecret: 'wui-secret' });
  const callbackUrl = `http://127.0.0.1:${apiPort}/v1/links/callback`;
  const registry = new IdpRegistry();
  registry.register(
    'aurora-club',
    new FakeAuroraIdpAdapter({ issuer: idpIssuer, clientId: 'wui-client', clientSecret: 'wui-secret', redirectUri: callbackUrl }),
  );
  walletApi = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'wui-session',
    verifyBaseUrl: `${UI}/verify`,
    signer: new FakeSigner(SIGNER_SECRET),
    resolveIdpAdapter: (programme) => registry.resolve(programme),
    linkCallbackUrl: callbackUrl,
  });
  await walletApi.listen({ port: apiPort, host: '127.0.0.1' });

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 240_000 });
  }
  ui = spawn('pnpm', ['exec', 'next', 'start', '-p', String(UI_PORT)], {
    cwd: appRoot,
    env: {
      ...process.env,
      MERITED_WALLET_API_URL: `http://127.0.0.1:${apiPort}`,
      MERITED_CORE_API_URL: coreUrl,
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${UI}/login`, { redirect: 'manual' })).status === 200) break;
    } catch {
      /* booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // magic-link login THROUGH the UI: request via the proxy, link lands on /verify
  const email = 'wui@example.co.uk';
  const requested = await post('/api/auth/request', { email });
  expect([302, 303]).toContain(requested);
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const link = full.Text.match(/https?:\/\/\S+/)![0];
  expect(link).toContain(`${UI}/verify`); // the UI owns the landing
  const verified = await fetch(link, { redirect: 'manual' });
  expect(verified.status).toBe(303);
  cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(cookie).toContain('merited_wallet_session=');

  const { rows } = await pool.query<{ consumer_ref: string }>(
    `SELECT consumer_ref FROM wallet.consumers WHERE email = $1`,
    [email],
  );
  consumerRef = rows[0]!.consumer_ref;

  // read-model fixtures: one active Aurora link + two points credits
  await pool.query(
    `INSERT INTO wallet.identity_links (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes)
     VALUES ($1, $2, $3, 'aurora-club', 'am_seed_cyn', $4, '["loyalty_ids","member_pricing"]'::jsonb)`,
    [newId('lnk'), consumerRef, seededMerchant, gold.sub_hash],
  );
  await pool.query(
    `INSERT INTO wallet.points_credits (claim_id, consumer_ref, programme, member_ref, points, order_ref_hash, quote_id, gross_pence)
     VALUES ($1, $2, 'aurora-club', 'am_seed_cyn', 84, $3, $4, 8450),
            ($5, $2, 'aurora-club', 'am_seed_cyn', 50, $6, $7, 5000)`,
    [newId('clm'), consumerRef, newId('clm'), newId('qte'), newId('clm'), newId('clm'), newId('qte')],
  );
}, 300_000);

afterAll(async () => {
  ui?.kill('SIGTERM');
  await walletApi.close();
  await idp.close();
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-3 slice 1: screens 1–3 over the wallet API alone', () => {
  it('screen 1 (home/balances): linked programmes + points from read models', async () => {
    const { status, html } = await get('/');
    expect(status).toBe(200);
    expect(html).toContain(consumerRef);
    expect(html).toContain('aurora-club');
    expect(html).toContain('am_seed_cyn');
    expect(html).toContain('>134<'); // 84 + 50, summed per programme
    expect(html).toMatch(/2(<!-- -->)? rewarded deal/); // JSX text-node comment separators
  });

  it('an unauthenticated visitor is redirected to /login; login page renders', async () => {
    const anon = await fetch(`${UI}/`, { redirect: 'manual' });
    expect([302, 307]).toContain(anon.status);
    expect(anon.headers.get('location')).toContain('/login');
    const { html } = await get('/login');
    expect(html).toContain('sign-in link');
  });

  it('screen 4 (offers for you): T1 quotes through the ORDINARY agent read API — P5, no backdoor', async () => {
    const { status, html } = await get('/offers');
    expect(status).toBe(200);
    expect(html).toContain('data-tier="T1"'); // the link's sub_hash resolved T1
    expect(html).toMatch(/£\d+\.\d{2}/); // member pricing in pounds from pence
  });

  it('screen 2: the link button starts the REAL OIDC dance — browser sent to the brand IdP', async () => {
    const response = await fetch(`${UI}/api/links/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ merchant_id: seededMerchant, programme: 'aurora-club' }).toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    const location = response.headers.get('location')!;
    expect(location).toContain('/authorize'); // the FakeAurora IdP authorise URL
    expect(location).toContain('code_challenge'); // PKCE rides from the wallet
  });

  it('screen 6 (activity): credits and locked-price approvals from ledger-derived rows only', async () => {
    // an approval the consumer made, joined to its quote's locked price
    await pool.query(
      `INSERT INTO core.quotes (quote_id, offer_id, commitment_id, agent_id, tier, segment,
                                list_amount, final_amount, mechanics_applied, expires_at, inputs_snapshot)
       VALUES ('qte_00WV1ACT0V0TY000000000001', 'off_00WV1ACT0FFER000000000001', 'com_00WV1ACTC0MM0T00000000001',
               'agt_00WV1ACTAGENT000000000001', 'T1', 't1-gold-new', 8450, 7183, '[]'::jsonb,
               now() + interval '10 minutes', '{}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO wallet.mandates (mandate_id, consumer_ref, agent_id, scopes, limits, merchants,
                                    data_sharing, pre_authorised_up_to, status, exp, attestation)
       VALUES ('mnd_00WV1ACTMANDATE0000000001', $1, 'agt_00WV1ACTAGENT000000000001',
               '["checkout:execute"]'::jsonb,
               '{"per_txn":{"amount":10000,"currency":"GBP_pence"},"per_month":{"amount":50000,"currency":"GBP_pence"},"categories":[]}'::jsonb,
               '["*"]'::jsonb, '{"email":false,"purchase_history":false,"loyalty_ids":true}'::jsonb,
               '{"amount":2000,"currency":"GBP_pence"}'::jsonb, 'active', now() + interval '30 days', 'fake:a')`,
      [consumerRef],
    );
    await pool.query(
      `INSERT INTO wallet.approvals (approval_id, mandate_id, quote_id, mode, exp, attestation)
       VALUES ('apr_00WV1ACTAPPR0VED000000001', 'mnd_00WV1ACTMANDATE0000000001',
               'qte_00WV1ACT0V0TY000000000001', 'explicit', now() + interval '10 minutes', 'fake:b')`,
    );

    const { status, html } = await get('/activity');
    expect(status).toBe(200);
    expect(html).toContain('data-credit="aurora-club"'); // what you earned
    expect(html).toContain('>84<');
    expect(html).toContain('data-approval-mode="explicit"'); // the locked price
    expect(html).toContain('£71.83');
    expect(html).toContain('No errands yet'); // errand trail arrives with screen 5
  });

  it('screen 2 (linked accounts): scopes visible; REVOKE is live and immediate', async () => {
    const before = await get('/accounts');
    expect(before.html).toContain('loyalty_ids, member_pricing');
    expect(before.html).toContain('data-link-status="active"');

    const { rows } = await pool.query<{ link_id: string }>(
      `SELECT link_id FROM wallet.identity_links WHERE consumer_ref = $1`,
      [consumerRef],
    );
    const revoked = await post(`/api/links/${rows[0]!.link_id}/revoke`, {});
    expect([302, 303]).toContain(revoked);

    const after = await get('/accounts');
    expect(after.html).toContain('data-link-status="revoked"');
    expect(after.html).not.toContain('data-link-status="active"');
    // the identity signal is GONE from home too — B23's UI face
    expect((await get('/')).html).toContain('Nothing linked');
  });

  it('W13/#9: a failed link start surfaces an in-page role="alert" (SC 3.3.1/4.1.3)', async () => {
    const failed = await get('/accounts?link_failed=1');
    expect(failed.html).toContain('role="alert"');
    expect(failed.html).toContain('start linking');
    // no flag → no alert
    expect((await get('/accounts')).html).not.toContain('role="alert"');
  });

  it('screen 3 (mandate): grant with pounds-only limits, then revoke — both through the public API', async () => {
    const agentId = newId('agt');
    const granted = await post('/api/mandates', {
      agent_id: agentId,
      per_txn_pounds: '100',
      per_month_pounds: '500',
      pre_auth_pounds: '20',
      categories: 'experiences',
      exp_days: '30',
    });
    expect([302, 303]).toContain(granted);

    const page = await get('/mandate');
    expect(page.html).toContain('data-mandate-status="active"');
    expect(page.html).toContain('£100.00'); // per txn
    expect(page.html).toContain('£20.00'); // pre-authorised threshold
    expect(page.html).toContain('experiences');

    const { rows } = await pool.query<{ mandate_id: string; attestation: string }>(
      `SELECT mandate_id, attestation FROM wallet.mandates WHERE consumer_ref = $1`,
      [consumerRef],
    );
    expect(rows[0]!.attestation).toBeTruthy(); // the REAL grant path signed it

    const revoked = await post(`/api/mandates/${rows[0]!.mandate_id}/revoke`, {});
    expect([302, 303]).toContain(revoked);
    const after = await get('/mandate');
    expect(after.html).toContain('data-mandate-status="revoked"');
  });
});
