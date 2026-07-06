import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cpclm_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const PORT = 5400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

let admin: pg.Client;
let pool: pg.Pool;
let server: ChildProcess | null = null;
let cookie = '';
let merchantId = '';

const get = async (pathname: string): Promise<{ status: number; html: string }> => {
  const response = await fetch(`${BASE}${pathname}`, { redirect: 'manual', headers: { cookie } });
  return { status: response.status, html: (await response.text()).replace(/<script[\s\S]*?<\/script>/g, '') };
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

  // a merchant + the three claims the Accept names, with a quote for the audit path
  await pool.query(
    `INSERT INTO core.merchants (merchant_id, name, slug, commercial)
     VALUES ('mer_00TESTAVR0RA00000000000001', 'Aurora Experiences', 'aurora-experiences', $1::jsonb)`,
    [JSON.stringify({ take_rate_bps: 2000, agent_commission_bps: 6000, attribution_window_s: 86400, clawback_window_s: 2592000, budgets: { per_offer_default: null } })],
  );
  merchantId = 'mer_00TESTAVR0RA00000000000001';
  await pool.query(
    `INSERT INTO core.quotes (quote_id, offer_id, commitment_id, agent_id, tier, segment,
                              list_amount, final_amount, mechanics_applied, token_jti, expires_at, inputs_snapshot)
     VALUES ('qte_00TESTQV0TE000000000000001', 'off_00TESTA0000000000000000001', 'com_00TESTC0000000000000000001',
             'agt_00TESTA0000000000000000001', 'T1', 'acquisition', 8450, 8450, '[]'::jsonb,
             'atk_00TESTT0KEN000000000000001', now() + interval '10 minutes', '{}'::jsonb)`,
  );
  const insertClaim = (claimId: string, verdict: string, reason: string | null) =>
    pool.query(
      `INSERT INTO core.claims_intake (claim_id, merchant_id, order_ref_hash, gross_pence, jti, qid, cid, verdict, reason_code)
       VALUES ($1, $2, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 8450,
               'atk_00TESTT0KEN000000000000001', 'qte_00TESTQV0TE000000000000001', 'com_00TESTC0000000000000000001', $3, $4)`,
      [claimId, merchantId, verdict, reason],
    );
  await insertClaim('clm_00TESTVER1F1ED000000000001', 'verified', null);
  await insertClaim('clm_00TESTREP1AYED000000000001', 'rejected', 'TOKEN_REPLAYED');
  await insertClaim('clm_00TESTEXP1RED0000000000001', 'rejected', 'QUOTE_EXPIRED');

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 240_000 });
  }
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: appRoot,
    env: {
      ...process.env,
      MERITED_DATABASE_URL: appUrl,
      CONTROL_PLANE_SESSION_SECRET: 'cp-claims-session',
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

describe('claims viewer (MER-10 accept — merchants see why, from this screen alone)', () => {
  it('the list shows all three seeded claims with their correct codes', async () => {
    const { status, html } = await get(`/claims?merchant=${merchantId}`);
    expect(status).toBe(200);
    expect(html).toContain('verified');
    expect(html).toContain('TOKEN_REPLAYED');
    expect(html).toContain('QUOTE_EXPIRED');
    expect(html).toContain('£84.50');
  });

  it('filtering by reason code narrows the list and explains the code in plain English', async () => {
    const { html } = await get(`/claims?merchant=${merchantId}&reason=TOKEN_REPLAYED`);
    expect(html).toContain('<code>TOKEN_REPLAYED</code>'); // a table row, not the dropdown
    expect(html).not.toContain('<code>QUOTE_EXPIRED</code>');
    expect(html).not.toContain('clm_00TESTEXP1RED'); // the expired claim is filtered out
    expect(html).toContain('already been redeemed');
  });

  it('the detail view shows the full audit path claim → jti → qid → cid and the quote-time price', async () => {
    const { html } = await get('/claims/clm_00TESTREP1AYED000000000001');
    expect(html).toContain('clm_00TESTREP1AYED000000000001');
    expect(html).toContain('atk_00TESTT0KEN000000000000001'); // jti
    expect(html).toContain('qte_00TESTQV0TE000000000000001'); // qid
    expect(html).toContain('com_00TESTC0000000000000000001'); // cid
    expect(html).toContain('This attribution token has already been redeemed.');
    expect(html).toContain('List £84.50 → final £84.50 at tier T1');
    // W15/#17 (SC 1.3.1): the audit rows use th scope="row", not td, for labels
    expect(html).toMatch(/<th scope="row"[^>]*>Claim<\/th>/);
    expect(html).toMatch(/<th scope="row"[^>]*>Commitment \(cid\)<\/th>/);
    // W15 (SC 2.4.1): the skip-to-content link ships on every control-plane page
    expect(html).toContain('Skip to content');
    expect(html).toContain('id="main-content"');
  });

  it('a verified claim reads clean — no reason code, no explanation', async () => {
    const { html } = await get('/claims/clm_00TESTVER1F1ED000000000001');
    expect(html).toContain('verified');
    expect(html).not.toContain('already been redeemed');
  });
});
