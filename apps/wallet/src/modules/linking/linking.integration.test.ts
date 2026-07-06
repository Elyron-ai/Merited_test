import { verifyChain } from '@merited/events';
import { FakeAuroraIdpAdapter, IdpRegistry } from '@merited/core';
import { createFakeAuroraIdp, type FakeAuroraIdp } from '@merited/fake-aurora';
import { type FastifyInstance } from 'fastify';
import { createServer } from 'node:http';
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

/**
 * PH1-13 accept (the gate: "OAuth linking round-trip in CI"): a full link
 * against FakeAurora — start → authorize → consent → callback → IdentityLink
 * + AccountLinked; revoke → status flips live + AccountUnlinked; refresh
 * tokens never appear in any response or in the ledger; both events land in
 * the hash-chained ledger and it still verifies.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_linking_${Date.now().toString(36)}`;
const CLIENT_ID = 'merited-wallet';
const CLIENT_SECRET = 'aurora-idp-secret';

let admin: pg.Client;
let pool: pg.Pool;
let idp: FakeAuroraIdp;
let idpIssuer: string;
let wallet: FastifyInstance;
let walletUrl: string;
let cookie: string;

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

/** Magic-link round-trip → a wallet session cookie for `email`. */
const loginAs = async (email: string): Promise<string> => {
  await fetch(`${walletUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const token = new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return verified.headers.get('set-cookie')!.split(';')[0]!;
};

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

  const idpPort = await freePort();
  idpIssuer = `http://127.0.0.1:${idpPort}`;
  idp = await createFakeAuroraIdp({ issuer: idpIssuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await idp.app.listen({ port: idpPort, host: '127.0.0.1' });

  const walletPort = await freePort();
  const callbackUrl = `http://127.0.0.1:${walletPort}/v1/links/callback`;
  const registry = new IdpRegistry().register(
    'aurora-club',
    new FakeAuroraIdpAdapter({ issuer: idpIssuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: callbackUrl }),
  );
  wallet = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'linking-test-secret',
    verifyBaseUrl: `http://127.0.0.1:${walletPort}/verify`,
    linkCallbackUrl: callbackUrl,
    resolveIdpAdapter: (programme) => registry.resolve(programme),
  });
  await wallet.listen({ port: walletPort, host: '127.0.0.1' });
  walletUrl = `http://127.0.0.1:${walletPort}`;

  // establish a wallet session (magic-link round-trip). No global Mailpit
  // wipe: the PH1-9 wallet suite shares this instance and runs concurrently,
  // so we scope the lookup to THIS recipient (newest-first) rather than
  // deleting everyone's mail.
  const linkerEmail = 'linker@example.co.uk';
  await fetch(`${walletUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: linkerEmail }),
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${linkerEmail}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const token = new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await wallet.close();
  await idp.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('account linking round-trip (PH1-13)', () => {
  let linkId: string;

  it('full OAuth link against FakeAurora: start → consent → callback → IdentityLink', async () => {
    // start
    const started = await (
      await fetch(`${walletUrl}/v1/links/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ merchant_id: 'mer_00SEEDAVR0RA00000000000000', programme: 'aurora-club' }),
      })
    ).json() as { authorize_url: string; state: string };
    expect(started.authorize_url).toContain('/authorize');

    // drive the IdP consent (the browser step)
    const authUrl = new URL(started.authorize_url);
    const consent = await fetch(`${idpIssuer}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        state: authUrl.searchParams.get('state') ?? '',
        scope: authUrl.searchParams.get('scope') ?? '',
        redirect_uri: authUrl.searchParams.get('redirect_uri') ?? '',
        code_challenge: authUrl.searchParams.get('code_challenge') ?? '',
        username: 'cyn', // a Gold member
        password: 'aurora',
        decision: 'approve',
      }),
    });
    const callbackTarget = new URL(consent.headers.get('location')!);

    // callback → the wallet completes the link (same session cookie)
    const callbackResponse = await fetch(
      `${walletUrl}/v1/links/callback?state=${callbackTarget.searchParams.get('state')}&code=${callbackTarget.searchParams.get('code')}`,
      { headers: { cookie } },
    );
    expect(callbackResponse.status).toBe(200);
    const bodyText = await callbackResponse.text();
    const { link } = JSON.parse(bodyText) as { link: { link_id: string; status: string; sub_hash: string; member_ref: string } };
    expect(link.status).toBe('active');
    expect(link.member_ref).toMatch(/^mbr_/); // tokenised, not the raw sub
    expect(link.sub_hash).toHaveLength(64);
    linkId = link.link_id;

    // NO refresh/access token anywhere in the response
    expect(bodyText).not.toMatch(/refresh_token|access_token|"rt"|"at"/);
  });

  it('the refresh token is sealed at rest — not plaintext in link_tokens', async () => {
    const { rows } = await pool.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM wallet.link_tokens WHERE link_id = $1`,
      [linkId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ciphertext).not.toContain('refresh');
  });

  it('AccountLinked landed in the hash-chained ledger', async () => {
    const { rows } = await pool.query<{ type: string; body: string }>(
      `SELECT type, body::text FROM events.events WHERE type = 'AccountLinked' ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).not.toMatch(/refresh_token|access_token/); // the event carries the link only
  });

  it('SECURITY: revoke is consumer-scoped — another session cannot unlink this link (IDOR)', async () => {
    // a second consumer (own session) tries to revoke consumer 1's still-active link
    const attackerCookie = await loginAs('link-attacker@example.co.uk');
    const attempt = (await (
      await fetch(`${walletUrl}/v1/links/${linkId}/revoke`, { method: 'POST', headers: { cookie: attackerCookie } })
    ).json()) as { revoked: boolean };
    expect(attempt.revoked).toBe(false); // refused — not the owner

    // the victim's link is untouched and its sealed tokens survive
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM wallet.identity_links WHERE link_id = $1`,
      [linkId],
    );
    expect(status.rows[0]!.status).toBe('active');
    const tokens = await pool.query(`SELECT 1 FROM wallet.link_tokens WHERE link_id = $1`, [linkId]);
    expect(tokens.rowCount).toBe(1);
  });

  it('revoke: status flips LIVE (no cache), AccountUnlinked emitted, chain verifies', async () => {
    const revoked = await (
      await fetch(`${walletUrl}/v1/links/${linkId}/revoke`, { method: 'POST', headers: { cookie } })
    ).json() as { revoked: boolean };
    expect(revoked.revoked).toBe(true);

    // LIVE read — the very next status read sees 'revoked' (no cache window)
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM wallet.identity_links WHERE link_id = $1`,
      [linkId],
    );
    expect(rows[0]!.status).toBe('revoked');

    // AccountUnlinked in the ledger
    const unlinked = await pool.query(`SELECT 1 FROM events.events WHERE type = 'AccountUnlinked'`);
    expect(unlinked.rowCount).toBe(1);

    // sealed tokens dropped
    const tokens = await pool.query(`SELECT 1 FROM wallet.link_tokens WHERE link_id = $1`, [linkId]);
    expect(tokens.rowCount).toBe(0);

    // the hash chain still verifies over both AccountLinked + AccountUnlinked
    const client = await pool.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification.ok).toBe(true);
    } finally {
      client.release();
    }

    // revoke is idempotent — a second revoke is a no-op
    const again = await (
      await fetch(`${walletUrl}/v1/links/${linkId}/revoke`, { method: 'POST', headers: { cookie } })
    ).json() as { revoked: boolean };
    expect(again.revoked).toBe(false);
  });

  it('linking routes require a session (authn on every route)', async () => {
    expect((await fetch(`${walletUrl}/v1/links/start`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${walletUrl}/v1/links/callback?state=x&code=y`)).status).toBe(401);
  });

  it('W9/#30: a failed callback returns a uniform code with NO message (no ownership oracle)', async () => {
    // With a valid session but a bogus state the handler catch runs. Previously
    // it echoed error.message — "invalid or expired" vs "does not belong to this
    // session" — a consumer-ownership oracle. Now the body is code-only.
    const res = await fetch(`${walletUrl}/v1/links/callback?state=nonexistent-state&code=whatever`, {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message?: string } };
    expect(body.error.code).toBe('LINK_CALLBACK_FAILED');
    expect(body.error.message).toBeUndefined();
  });

  it('W6: a cross-site state-changing POST is refused (CSRF)', async () => {
    // browser cross-origin POST → 403 before any handler runs; a same-origin /
    // no-Origin caller (the tests, valet, wallet-ui proxy) is unaffected
    const blocked = await fetch(`${walletUrl}/v1/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'x@example.co.uk' }),
    });
    expect(blocked.status).toBe(403);
    const ok = await fetch(`${walletUrl}/v1/auth/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // no Origin → allowed
      body: JSON.stringify({ email: 'x@example.co.uk' }),
    });
    expect(ok.status).toBe(202);
  });
});
