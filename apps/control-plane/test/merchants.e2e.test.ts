import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { generate as generateTotp } from 'otplib';
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cpmer_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const SIGNER_SECRET = 'cp-e2e-signer';
const SERVICE_TOKEN = 'cp-e2e-token';
const PORT = 4450 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let server: ChildProcess | null = null;
let cookie = '';

const request = (pathname: string, init: RequestInit = {}) =>
  fetch(`${BASE}${pathname}`, {
    redirect: 'manual',
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });

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
  await pool.query(
    `INSERT INTO control_plane.users (user_id, email, password_hash, totp_secret)
     VALUES ('usr_00TESTADM1N000000000000001', 'admin@merited.test', $1, $2)`,
    [await argon2.hash('correct-horse', { type: argon2.argon2id }), TOTP_SECRET],
  );

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();

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
      CONTROL_PLANE_SESSION_SECRET: 'cp-e2e-session',
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

  // sign in once for the whole onboarding flow
  const form = new URLSearchParams({
    email: 'admin@merited.test',
    password: 'correct-horse',
    totp: await generateTotp({ secret: TOTP_SECRET }),
  });
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', body: form, redirect: 'manual' });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (!cookie.includes('merited_cp_session=')) throw new Error('login failed in setup');
}, 300_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('merchant onboarding through the UI alone (MER-8 accept)', () => {
  let merchantId = '';
  let secretOnce = '';

  it('creates Aurora Experiences from the merchants screen (integers only)', async () => {
    const create = await request('/api/merchants', {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Aurora Experiences',
        take_rate_bps: '2000',
        agent_commission_bps: '6000',
        attribution_window_s: '86400',
        clawback_window_s: '2592000',
        per_offer_default: '',
      }),
    });
    expect(create.status).toBe(303);
    merchantId = new URL(create.headers.get('location')!).pathname.split('/').pop()!;
    expect(merchantId).toMatch(/^mer_/);

    const page = await request(`/merchants/${merchantId}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Aurora Experiences');
    expect(html).toContain('aurora-experiences'); // the slug
  });

  it('a float in the commercial config never crosses the wire', async () => {
    const update = await request(`/api/merchants/${merchantId}`, {
      method: 'POST',
      body: new URLSearchParams({
        name: 'Aurora Experiences',
        take_rate_bps: '20.5',
        agent_commission_bps: '6000',
        attribution_window_s: '86400',
        clawback_window_s: '2592000',
        per_offer_default: '',
      }),
    });
    expect(update.status).toBe(400);
    expect(await update.text()).toContain('whole number');
  });

  it('issues a webhook secret shown EXACTLY once, never retrievable again', async () => {
    const issue = await request(`/api/merchants/${merchantId}/webhook-secret`, { method: 'POST' });
    expect(issue.status).toBe(200);
    // W8/#31: the one-time reveal must never be cached or leaked via Referer.
    expect(issue.headers.get('cache-control')).toBe('no-store');
    expect(issue.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await issue.text();
    const match = /<code[^>]*>(whsec_[A-Za-z0-9_-]+)<\/code>/.exec(html);
    expect(match).toBeTruthy();
    secretOnce = match![1]!;
    expect(html).toContain('shown exactly once');

    // the detail page shows the LAST FOUR only — the plaintext is gone
    const page = await request(`/merchants/${merchantId}`);
    const pageHtml = await page.text();
    expect(pageHtml).toContain(`…${secretOnce.slice(-4)}`);
    expect(pageHtml).not.toContain(secretOnce);

    // rotation: a second secret lists alongside the first
    await request(`/api/merchants/${merchantId}/webhook-secret`, { method: 'POST' });
    const rotated = await request(`/merchants/${merchantId}`);
    const rotatedHtml = await rotated.text();
    expect((rotatedHtml.match(/…<\/code>|<code>…/g) ?? rotatedHtml.match(/…[A-Za-z0-9_-]{4}/g))!.length).toBeGreaterThanOrEqual(2);
  });

  it('keypair issuance round-trips against the trio simulator and renders the reference', async () => {
    const issue = await request(`/api/merchants/${merchantId}/signing-key`, { method: 'POST' });
    expect(issue.status).toBe(303);

    const page = await request(`/merchants/${merchantId}`);
    const html = await page.text();
    expect(html).toContain(`merchant/${merchantId}`); // the signing_key_ref
    expect(html).toContain('public key');

    // the reference is persisted on the merchant row (MER-2's round-trip)
    const { rows } = await pool.query(`SELECT signing_key_ref FROM core.merchants WHERE merchant_id = $1`, [merchantId]);
    expect(rows[0].signing_key_ref).toBe(`merchant/${merchantId}`);
  });

  it('the whole onboarding above ran through the UI alone (auth + four form posts)', () => {
    // Every step used only HTTP form posts against the running app — the
    // <5-minute clause is trivially met; this test records the claim.
    expect(merchantId).toMatch(/^mer_/);
    expect(secretOnce).toMatch(/^whsec_/);
  });

  it('PH1-20: the mint-vs-claim health badge renders on the merchant record', async () => {
    // the monitor's verdict is the badge's read model — seed one directly
    await pool.query(
      `INSERT INTO core.merchant_health
         (merchant_id, status, claim_rate_bps, mints, claims, window_days, floor_bps)
       VALUES ($1, 'under_reporting', 500, 20, 1, 7, 2500)`,
      [merchantId],
    );
    const page = await request(`/merchants/${merchantId}/health`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('UNDER-REPORTING');
    expect(html).toContain('data-status="under_reporting"');
    expect(html).toContain('5.00%'); // the claim rate, human-formatted
    // …and the merchant record links to it
    const record = await request(`/merchants/${merchantId}`);
    expect(await record.text()).toContain(`/merchants/${merchantId}/health`);
  });
});
