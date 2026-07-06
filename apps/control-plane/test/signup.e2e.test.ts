import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateControlPlane } from '../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../trio/scripts/migrate.mjs';

/**
 * PH3-6 accept — the Phase-3 gate clause: "a new merchant self-onboards
 * without manual steps — scripted E2E: fresh signup through to that
 * merchant's offer returning as a quote to a registered agent, with no
 * operator action." NO session cookie is used ANYWHERE in this suite: the
 * signup is the public surface, and the operator dashboard is asserted to
 * stay locked throughout.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_signup_${Date.now().toString(36)}`;
const SIGNER_SECRET = 'signup-e2e-signer';
const SERVICE_TOKEN = 'signup-e2e-token';
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let coreUrl = '';
let server: ChildProcess | null = null;

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateControlPlane(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 240_000 });
  }
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: appRoot,
    env: {
      ...process.env,
      MERITED_DATABASE_URL: appUrl,
      MERITED_TRIO_URL: trioUrl,
      MERITED_TRIO_SERVICE_TOKEN: SERVICE_TOKEN,
      MERITED_SIGNER_SECRET: SIGNER_SECRET,
      CONTROL_PLANE_SESSION_SECRET: 'signup-e2e-session',
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/login`, { redirect: 'manual' })).status === 200) break;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // deliberately NO login — self-serve means no operator session exists
}, 300_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('self-serve merchant onboarding (PH3-6 gate clause)', () => {
  let signup: {
    merchant: { merchant_id: string; slug: string; name: string };
    signing_key: string;
    integration: { selected: string; endpoint: string; webhook_secret: string };
    offer: { offer_id: string; commitment_id: string; status: string };
  };

  it('the signup page is public; the operator dashboard stays locked', async () => {
    const page = await fetch(`${BASE}/signup`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sell to agents on Merited');

    for (const guarded of ['/merchants', '/offers', '/dashboard', '/claims']) {
      const locked = await fetch(`${BASE}${guarded}`, { redirect: 'manual' });
      expect([303, 307, 308]).toContain(locked.status);
      expect(locked.headers.get('location')).toContain('/login');
    }
  });

  it('fresh signup: merchant → keypair → integration → commercial → first LIVE offer, one POST, no session', async () => {
    const response = await fetch(`${BASE}/api/signup`, {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Borealis Retreats',
        integration: 'grade_b',
        take_rate_bps: '1800',
        agent_commission_bps: '5500',
        attribution_window_s: '86400',
        clawback_window_s: '2592000',
        per_offer_default: '500000',
        type: 'percentage_off',
        title: 'Northern lights weekend — agent launch price',
        description: 'Two nights, aurora viewing deck, launch discount for agent checkouts',
        mech_pct_bps: '1500',
        sku_scope: 'all',
        identity_tiers: 'T1,T2,T3',
        stacking_group: '',
        valid_from: iso(-60),
        valid_until: iso(180 * 86400),
        bounty_type: 'fixed',
        bounty_amount: '750',
      }),
      redirect: 'manual',
    });
    expect(response.status).toBe(201);
    // W8/#31: this response carries the plaintext webhook_secret exactly once —
    // it must not be cached and must not leak on the Referer header.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    // W8/#15/#19: HSTS is emitted in production (this server runs NODE_ENV=production).
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    signup = await response.json();

    expect(signup.merchant.merchant_id).toMatch(/^mer_/);
    expect(signup.merchant.slug).toBe('borealis-retreats');
    expect(signup.signing_key).toBe('issued');
    expect(signup.integration.endpoint).toBe(
      `/v1/merchants/borealis-retreats/webhooks/order-confirmed`,
    );
    expect(signup.integration.webhook_secret).toMatch(/^whsec_/); // shown exactly once
    expect(signup.offer.offer_id).toMatch(/^off_/);
    expect(signup.offer.commitment_id).toMatch(/^com_/); // COR countersigned
    expect(signup.offer.status).toBe('live');

    // the custodied keypair really exists — claims can form from day one
    const keys = await pool.query(
      `SELECT signing_key_ref FROM core.merchant_signing_keys WHERE merchant_id = $1`,
      [signup.merchant.merchant_id],
    );
    expect(keys.rows).toHaveLength(1);
  });

  it('GATE CLAUSE: the new merchant’s offer returns as a QUOTE to a registered agent', async () => {
    const agent = await core.agents.register({
      name: 'SignupProbe',
      contact: 'probe@merited.test',
    });
    const read = await fetch(`${coreUrl}/v1/offers?text=northern%20lights`, {
      headers: { 'x-merited-agent-key': agent.api_key },
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      quotes: Array<{ offer_id: string; quote_id: string; token: string | null }>;
    };
    const quote = body.quotes.find((q) => q.offer_id === signup.offer.offer_id);
    expect(quote).toBeDefined();
    expect(quote!.quote_id).toMatch(/^qte_/);
    expect(quote!.token).not.toBeNull(); // payable, minted through the canonical path
  });

  it('the Shopify integration selection wires the orders/paid endpoint instead', async () => {
    const response = await fetch(`${BASE}/api/signup`, {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Glacier Days',
        integration: 'shopify',
        take_rate_bps: '2000',
        agent_commission_bps: '6000',
        attribution_window_s: '86400',
        clawback_window_s: '2592000',
        per_offer_default: '',
        type: 'percentage_off',
        title: 'Glacier hike intro offer',
        description: 'Guided glacier hike, agent launch discount',
        mech_pct_bps: '1000',
        sku_scope: 'all',
        identity_tiers: 'T1,T2,T3',
        stacking_group: '',
        valid_from: iso(-60),
        valid_until: iso(180 * 86400),
        bounty_type: 'pct_of_order',
        bounty_pct_bps: '400',
      }),
      redirect: 'manual',
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.integration.endpoint).toBe(`/v1/merchants/glacier-days/shopify/orders-paid`);
    expect(body.integration.scheme).toContain('shopify-native');
    expect(body.offer.status).toBe('live');
  });

  it('bad input never half-onboards: an invalid bounty rejects with 400', async () => {
    const response = await fetch(`${BASE}/api/signup`, {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Half Formed Ltd',
        integration: 'grade_b',
        take_rate_bps: '2000',
        agent_commission_bps: '6000',
        attribution_window_s: '86400',
        clawback_window_s: '2592000',
        type: 'percentage_off',
        title: 'x',
        description: 'x',
        mech_pct_bps: '1000',
        sku_scope: 'all',
        identity_tiers: 'T1',
        stacking_group: '',
        valid_from: iso(-60),
        valid_until: iso(86400),
        bounty_type: 'nonsense',
      }),
      redirect: 'manual',
    });
    expect(response.status).toBe(400);
    // W9/#29: a caller-input error surfaces a coded, useful message — never a
    // raw Postgres/trio string. The bare `{ error: { message } }` shape is gone.
    const body = (await response.json()) as { error: { code: string; message?: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.message).toBeTruthy();
    expect(body.error.message).not.toMatch(/postgres|relation|syntax|constraint|ECONNREFUSED|at Object/i);
  });
});
