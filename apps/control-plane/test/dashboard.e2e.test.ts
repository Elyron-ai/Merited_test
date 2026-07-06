import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, pence, type Commitment } from '@merited/contracts';
import { analyticsProjection } from '@merited/core';
import { appendEventInNewTx, catchUp, rebuildProjection } from '@merited/events';
import argon2 from 'argon2';
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

/**
 * PH2-2 accept: "Dashboard renders from projections alone; after
 * `pnpm analytics:rebuild` from wiped schema the dashboard is identical
 * (extends §5.9 Accept). `BUDGET_EXHAUSTED` from PH2-1 visible here
 * (closes the §5.6 Accept loop)." The fixture ledger includes BOTH ways
 * BUDGET_EXHAUSTED can occur: a verify-path ConversionRejected and a
 * read-path OfferSuppressed (SYN-41).
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cpdash_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const PORT = 5400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

const MERCHANT = 'mer_00TESTDASHB0ARD00000000001' as const;
const AGENT = 'agt_00TESTDASHAGENT00000000001' as const;
const CID = 'com_00TESTDASHC0MM000000000001' as const;
const OFFER = 'off_00TESTDASH0FFER00000000001' as const;

let admin: pg.Client;
let pool: pg.Pool;
let server: ChildProcess | null = null;
let cookie = '';

const get = async (pathname: string): Promise<{ status: number; html: string }> => {
  const response = await fetch(`${BASE}${pathname}`, { redirect: 'manual', headers: { cookie } });
  return { status: response.status, html: (await response.text()).replace(/<script[\s\S]*?<\/script>/g, '') };
};

const commitment: Commitment = {
  commitment_id: CID,
  merchant_id: MERCHANT,
  offer_ref: OFFER,
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
  merchant_sig: 'fake-ed25519:m',
  platform_sig: 'fake-ed25519:p',
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateControlPlane(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});
  await pool.query(
    `INSERT INTO control_plane.users (user_id, email, password_hash, totp_secret)
     VALUES ('usr_00TESTADM1N000000000000001', 'admin@merited.test', $1, $2)`,
    [await argon2.hash('correct-horse', { type: argon2.argon2id }), TOTP_SECRET],
  );
  await pool.query(
    `INSERT INTO core.merchants (merchant_id, name, slug, commercial)
     VALUES ($1, 'Aurora Experiences', 'aurora-experiences', $2::jsonb)`,
    [MERCHANT, JSON.stringify({ take_rate_bps: 2000, agent_commission_bps: 6000, attribution_window_s: 86400, clawback_window_s: 2592000, budgets: { per_offer_default: null } })],
  );

  // the ledger IS the fixture — every dashboard number must derive from it
  const jti = newId('atk');
  const claimId = newId('clm');
  await appendEventInNewTx(pool, 'CommitmentCreated', { commitment });
  await appendEventInNewTx(pool, 'TokenMinted', {
    claims: {
      jti, cid: CID, qid: newId('qte'), aid: AGENT, tier: 'T3' as const,
      sid: 'a'.repeat(64), apr: null,
      iat: Math.floor(Date.parse('2026-07-04T10:00:00Z') / 1000),
      exp: Math.floor(Date.parse('2026-07-04T10:10:00Z') / 1000),
    },
  });
  await appendEventInNewTx(pool, 'ConversionClaimed', {
    claim_id: claimId, merchant_id: MERCHANT, jti, qid: newId('qte'), cid: CID,
    order_ref_hash: 'b'.repeat(64), gross_value: pence(8450), ts: '2026-07-04T11:00:00Z',
  });
  await appendEventInNewTx(pool, 'ConversionVerified', {
    claim_id: claimId, merchant_id: MERCHANT, jti, qid: newId('qte'), cid: CID,
    gross_value: pence(8450), verified_at: '2026-07-04T11:00:01Z',
  });
  // verify-path BUDGET_EXHAUSTED (jti unparseable → '(unknown)' agent)
  await appendEventInNewTx(pool, 'ConversionRejected', {
    claim_id: newId('clm'), merchant_id: MERCHANT, jti: null,
    reason_code: 'BUDGET_EXHAUSTED', rejected_at: '2026-07-05T09:00:00Z',
  });
  // read-path suppressions from the PH2-1 guardrails (SYN-41)
  await appendEventInNewTx(pool, 'OfferSuppressed', {
    offer_id: OFFER, merchant_id: MERCHANT, commitment_id: CID,
    reason_code: 'BUDGET_EXHAUSTED', agent_id: AGENT,
    suppressed_at: '2026-07-05T09:30:00Z',
  });
  await appendEventInNewTx(pool, 'OfferSuppressed', {
    offer_id: OFFER, merchant_id: MERCHANT, commitment_id: CID,
    reason_code: 'MARGIN_CEILING_EXCEEDED', agent_id: AGENT,
    suppressed_at: '2026-07-05T09:31:00Z',
  });
  await catchUp(pool, analyticsProjection); // one cycle

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 240_000 });
  }
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: appRoot,
    env: {
      ...process.env,
      MERITED_DATABASE_URL: appUrl,
      CONTROL_PLANE_SESSION_SECRET: 'cp-dashboard-session',
      // prod mode (W8/W11) now requires these explicitly — the values match the
      // former dev fallbacks, so behaviour is unchanged
      MERITED_SIGNER_SECRET: 'trio-dev-secret',
      MERITED_TRIO_SERVICE_TOKEN: 'dev-service-token',
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
}, 300_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-2 merchant dashboard over B19 (renders from projections alone)', () => {
  it('ACCEPT: BUDGET_EXHAUSTED is visible on the merchant dashboard — §5.6 loop closed', async () => {
    const { status, html } = await get(`/merchants/${MERCHANT}/dashboard`);
    expect(status).toBe(200);
    // verify-path rejection + read-path suppression combine: count 2
    expect(html).toContain('BUDGET_EXHAUSTED');
    expect(html).toContain('The offer’s budget had been spent before this conversion.');
    // the PH2-1 read-path codes are first-class with their own plain English
    expect(html).toContain('MARGIN_CEILING_EXCEEDED');
    expect(html).toContain('more margin than your configured ceiling allows');
    // …and queryable per agent (§3: both sides see why)
    expect(html).toContain(AGENT);
  });

  it('mint-vs-claim and budget burn render from their projections, money in pounds from integer pence', async () => {
    const { html } = await get(`/merchants/${MERCHANT}/dashboard`);
    expect(html).toContain('2026-07-04'); // the mint/claim day row
    expect(html).toContain(CID);
    expect(html).toContain('£12.00'); // 1200p bounty burned, never a float
  });

  it('platform dashboard shows all four projections, including per-agent conversions', async () => {
    const { status, html } = await get('/dashboard');
    expect(status).toBe(200);
    expect(html).toContain(AGENT);
    expect(html).toContain('£84.50'); // gross from conversions_by_agent_day
    expect(html).toContain('BUDGET_EXHAUSTED');
    expect(html).toContain(MERCHANT); // budget burn by merchant
  });

  it('ACCEPT: after a wipe + rebuild from seq 0, both dashboards are byte-identical', async () => {
    const merchantBefore = (await get(`/merchants/${MERCHANT}/dashboard`)).html;
    const platformBefore = (await get('/dashboard')).html;
    expect(merchantBefore).toContain('BUDGET_EXHAUSTED'); // non-trivial baseline

    const replayed = await rebuildProjection(pool, analyticsProjection);
    expect(replayed).toBeGreaterThanOrEqual(6); // the full fixture ledger

    expect((await get(`/merchants/${MERCHANT}/dashboard`)).html).toBe(merchantBefore);
    expect((await get('/dashboard')).html).toBe(platformBefore);
  });
});
