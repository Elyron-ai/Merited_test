import { type FastifyInstance } from 'fastify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmtpMailer } from './lib/mailer/smtp.js';
import { buildWalletServer } from './server.js';

/**
 * PH1-9 accept: magic-link round-trip via Mailpit (request → extract link
 * from the email → session established); links single-use + expiring; authn
 * on every non-public route.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_wallet_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let baseUrl: string;
// injectable clock so expiry is deterministic
let nowMs = Date.parse('2026-07-05T12:00:00Z');
const clock = { now: () => new Date(nowMs) };

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateWallet(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  app = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    clock,
    sessionSecret: 'wallet-test-secret',
    verifyBaseUrl: 'https://wallet.merited.test/verify',
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

beforeEach(() => {
  // No global Mailpit wipe: this instance is shared with the linking suite,
  // which runs concurrently — a global DELETE races its in-flight email (and
  // vice versa). Each lookup is scoped to its own recipient instead.
  nowMs = Date.parse('2026-07-05T12:00:00Z');
});

/** Request a link for `email` and pull the token out of the Mailpit email. */
const requestAndExtractToken = async (email: string): Promise<string> => {
  const res = await fetch(`${baseUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(202);
  // Scope the lookup to THIS recipient (newest-first) so a concurrent suite
  // sharing the same Mailpit can't hand us its email — or wipe ours.
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as {
    messages: Array<{ ID: string }>;
  };
  const message = list.messages[0]!;
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${message.ID}`)).json()) as {
    Text: string;
  };
  return new URL(full.Text.match(/https:\/\/\S+/)![0]).searchParams.get('token')!;
};

const verify = (token: string) =>
  fetch(`${baseUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

describe('wallet magic-link auth (PH1-9)', () => {
  it('round-trip: request → email link → verify → session established, /me works', async () => {
    const token = await requestAndExtractToken('ada@example.co.uk');
    const verified = await verify(token);
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toContain('merited_wallet_session=');

    const me = await fetch(`${baseUrl}/v1/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json() as { consumer_ref: string }).consumer_ref).toMatch(/^usr_/);
  });

  it('links are SINGLE-USE: a second verify of the same token → 401', async () => {
    const token = await requestAndExtractToken('bea@example.co.uk');
    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(401); // already consumed
  });

  it('links EXPIRE: verifying after the TTL → 401', async () => {
    const token = await requestAndExtractToken('cyn@example.co.uk');
    nowMs += 16 * 60 * 1000; // past the 15-minute default
    expect((await verify(token)).status).toBe(401);
  });

  it('a garbage or forged token → 401 (uniform failure)', async () => {
    expect((await verify('not-a-real-token')).status).toBe(401);
  });

  it('authn on every route: no cookie → 401; a forged cookie → 401', async () => {
    expect((await fetch(`${baseUrl}/v1/me`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/pd`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/v1/me`, { headers: { cookie: 'merited_wallet_session=forged.sig' } }))
        .status,
    ).toBe(401);
  });

  it('logout destroys the session — the cookie no longer authenticates', async () => {
    const token = await requestAndExtractToken('dev@example.co.uk');
    const cookie = (await verify(token)).headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${baseUrl}/v1/me`, { headers: { cookie } })).status).toBe(200);
    await fetch(`${baseUrl}/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    expect((await fetch(`${baseUrl}/v1/me`, { headers: { cookie } })).status).toBe(401);
  });
});

describe('wallet consented 1PD (PH1-9)', () => {
  const authed = async (email: string): Promise<string> =>
    (await verify(await requestAndExtractToken(email))).headers.get('set-cookie')!.split(';')[0]!;

  it('put → list round-trips; consented flag is preserved', async () => {
    const cookie = await authed('pd@example.co.uk');
    await fetch(`${baseUrl}/v1/pd/dietary`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ value: 'vegetarian', consented: true }),
    });
    await fetch(`${baseUrl}/v1/pd/birthday`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ value: '01-04', consented: false }),
    });
    const list = (await (await fetch(`${baseUrl}/v1/pd`, { headers: { cookie } })).json()) as {
      items: Array<{ key: string; value: unknown; consented: boolean }>;
    };
    expect(list.items).toEqual([
      { key: 'birthday', value: '01-04', consented: false },
      { key: 'dietary', value: 'vegetarian', consented: true },
    ]);
  });
});
