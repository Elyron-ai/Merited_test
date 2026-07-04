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
const dbName = `merited_cpoff_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const SIGNER_SECRET = 'cp-offers-signer';
const SERVICE_TOKEN = 'cp-offers-token';
const PORT = 4900 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let server: ChildProcess | null = null;
let cookie = '';
let merchantId = '';

const request = (pathname: string, init: RequestInit = {}) =>
  fetch(`${BASE}${pathname}`, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers ?? {}) } });

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
      CONTROL_PLANE_SESSION_SECRET: 'cp-offers-session',
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/login`, { redirect: 'manual' })).status === 200) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    body: new URLSearchParams({
      email: 'admin@merited.test',
      password: 'correct-horse',
      totp: await generateTotp({ secret: TOTP_SECRET }),
    }),
    redirect: 'manual',
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

  // onboard the merchant through the UI (MER-8's surface)
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
  merchantId = new URL(create.headers.get('location')!).pathname.split('/').pop()!;
  await request(`/api/merchants/${merchantId}/signing-key`, { method: 'POST' });
}, 300_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('offer authoring (MER-9 accept — §5.1 through the generated form)', () => {
  let offerId = '';

  it('creates a draft from the union-generated form and renders it back for editing', async () => {
    const create = await request('/api/offers', {
      method: 'POST',
      body: new URLSearchParams({
        merchant_id: merchantId,
        type: 'member_price',
        title: 'Full spa day — Aurora Club price',
        description: 'A full spa day at the member price.',
        mech_sku_ref: 'sku_spa_day',
        mech_price: '8450',
        sku_scope: 'sku_spa_day',
        identity_tiers: 'T1, T2, T3',
        stacking_group: '',
        valid_from: iso(-3600),
        valid_until: iso(180 * 86400),
      }),
    });
    expect(create.status).toBe(303);
    offerId = new URL(create.headers.get('location')!).pathname.split('/').pop()!;
    expect(offerId).toMatch(/^off_/);

    const page = await request(`/offers/${offerId}`);
    const html = await page.text();
    expect(html).toContain('member_price');
    expect(html).toContain('8450'); // integer pence rendered back into the form
    expect(html).toContain('draft');
  });

  it('publishing with a fixed bounty lands OfferPublished + CommitmentCreated — read back from the LEDGER onto the page', async () => {
    const publish = await request(`/api/offers/${offerId}/publish`, {
      method: 'POST',
      body: new URLSearchParams({ bounty_type: 'fixed', bounty_amount: '1200' }),
    });
    expect(publish.status).toBe(303);

    const { rows: published } = await pool.query(
      `SELECT 1 FROM events.events WHERE type = 'OfferPublished' AND body->'data'->>'offer_id' = $1`,
      [offerId],
    );
    expect(published).toHaveLength(1);
    const { rows: cors } = await pool.query(
      `SELECT body->'data'->'commitment'->>'commitment_id' AS cid FROM events.events
        WHERE type = 'CommitmentCreated' AND body->'data'->'commitment'->>'offer_ref' = $1`,
      [offerId],
    );
    expect(cors).toHaveLength(1);

    const page = await request(`/offers/${offerId}`);
    const html = await page.text();
    expect(html).toContain('live');
    expect(html).toContain(cors[0].cid); // the commitment id on screen
    expect(html).toContain('merchant_sig');
    expect(html).toContain('platform_sig');
    expect(html).toContain('← current');
  });

  it('repricing a live bounty shows TWO CORs with the offer pointing at the current one', async () => {
    const reprice = await request(`/api/offers/${offerId}/bounty`, {
      method: 'POST',
      body: new URLSearchParams({ bounty_type: 'fixed', bounty_amount: '1500' }),
    });
    expect(reprice.status).toBe(303);

    const { rows } = await pool.query(
      `SELECT commitment_id FROM core.offer_commitments WHERE offer_id = $1 ORDER BY created_at`,
      [offerId],
    );
    expect(rows).toHaveLength(2);
    const { rows: offer } = await pool.query(
      `SELECT current_commitment_id FROM core.offers WHERE offer_id = $1`,
      [offerId],
    );
    expect(offer[0].current_commitment_id).toBe(rows[1].commitment_id);

    const page = await request(`/offers/${offerId}`);
    const html = await page.text();
    expect(html).toContain(rows[0].commitment_id);
    expect(html).toContain(rows[1].commitment_id);
    // exactly one "current" marker, on the NEW commitment — count in the
    // rendered DOCUMENT only (Next also embeds the RSC flight payload in an
    // inline script, which duplicates all visible text)
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(visible.match(/← current/g)).toHaveLength(1);
    const list = visible.slice(visible.indexOf('Commitment history'));
    expect(list.indexOf(rows[1].commitment_id)).toBeLessThan(list.indexOf('← current'));
    expect(list.indexOf(rows[0].commitment_id)).toBeLessThan(list.indexOf('(ended)') + 20);
    expect(visible).toContain('(ended)');
  });

  it('a float in a mechanics field is refused at the form boundary', async () => {
    const create = await request('/api/offers', {
      method: 'POST',
      body: new URLSearchParams({
        merchant_id: merchantId,
        type: 'percentage_off',
        title: 'Bad offer',
        description: 'x',
        mech_pct_bps: '10.5',
        sku_scope: 'all',
        identity_tiers: 'T1',
        stacking_group: '',
        valid_from: iso(0),
        valid_until: iso(86400),
      }),
    });
    expect(create.status).toBe(400);
    expect(await create.text()).toContain('whole number');
  });
});
