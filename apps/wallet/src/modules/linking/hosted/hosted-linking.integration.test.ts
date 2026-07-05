import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { verifyChain } from '@merited/events';
import { HostedLinkStartRequest } from '@merited/contracts';
import { FakeAuroraLoyalty } from '@merited/core';
import { createFakeAuroraLoyalty, type FakeAuroraLoyalty as FakeLoyaltyServer } from '@merited/fake-aurora';
import { type FastifyInstance } from 'fastify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../../lib/mailer/smtp.js';
import { buildWalletServer } from '../../../server.js';

/**
 * PH1-14 accept: the hosted-linking fallback for IdP-less programmes. A
 * member-number + verification-email loop (NEVER credential capture) yields an
 * `IdentityLink` byte-compatible with the OAuth flow's; no password field
 * exists anywhere in the flow; an unverified email produces no link.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_hosted_${Date.now().toString(36)}`;
const PROGRAMME = 'aurora-club';
const MEMBER = 'am_seed_ada'; // a real seeded Aurora member (Member tier)
const MEMBER_EMAIL = 'ada.hosted@example.co.uk';
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

let admin: pg.Client;
let pool: pg.Pool;
let loyalty: FakeLoyaltyServer;
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

/** Pull the newest verification token emailed to `email` out of Mailpit. */
const tokenEmailedTo = async (email: string): Promise<string | null> => {
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  if (!list.messages[0]) return null;
  const full = (await (
    await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0].ID}`)
  ).json()) as { Text: string };
  return full.Text.match(/verification code:\s*(\S+)/i)?.[1] ?? null;
};

const hostedStart = (body: unknown): Promise<Response> =>
  fetch(`${walletUrl}/v1/links/hosted/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const hostedVerify = (body: unknown): Promise<Response> =>
  fetch(`${walletUrl}/v1/links/hosted/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

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

  // the brand's own loyalty API — the hosted flow confirms the member here
  loyalty = await createFakeAuroraLoyalty();
  const loyaltyUrl = await loyalty.listen();
  const loyaltyAdapter = new FakeAuroraLoyalty({ baseUrl: loyaltyUrl });

  const walletPort = await freePort();
  wallet = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'hosted-test-secret',
    verifyBaseUrl: `http://127.0.0.1:${walletPort}/verify`,
    resolveLoyalty: (programme) => (programme === PROGRAMME ? loyaltyAdapter : null),
  });
  await wallet.listen({ port: walletPort, host: '127.0.0.1' });
  walletUrl = `http://127.0.0.1:${walletPort}`;

  // establish a wallet session (magic-link round-trip, recipient-scoped)
  const sessEmail = 'hosted-linker@example.co.uk';
  await fetch(`${walletUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: sessEmail }),
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${sessEmail}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const magicToken = new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: magicToken }),
  });
  cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await wallet.close();
  await loyalty.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('hosted-linking fallback (PH1-14)', () => {
  it('the request schema has NO credential/password field — email is the only factor', () => {
    const keys = Object.keys(HostedLinkStartRequest.shape);
    expect(keys).toEqual(['merchant_id', 'programme', 'member_ref', 'email']);
    for (const forbidden of ['password', 'credential', 'secret', 'pin', 'login']) {
      expect(keys).not.toContain(forbidden);
    }
    // and a supplied credential field is not accepted into the parsed shape
    const parsed = HostedLinkStartRequest.parse({
      merchant_id: 'mer_00SEEDAVR0RA00000000000000',
      programme: PROGRAMME,
      member_ref: MEMBER,
      email: MEMBER_EMAIL,
      password: 'hunter2',
    } as unknown);
    expect(parsed).not.toHaveProperty('password');
  });

  let linkId: string;

  it('member-number + verification email → the SAME IdentityLink the OAuth flow yields', async () => {
    const started = (await (
      await hostedStart({ merchant_id: 'mer_00SEEDAVR0RA00000000000000', programme: PROGRAMME, member_ref: MEMBER, email: MEMBER_EMAIL })
    ).json()) as { attempt_id: string; verification_sent: boolean };
    expect(started.verification_sent).toBe(true);
    expect(started.attempt_id).toBeTruthy();

    // the emailed code (never a password prompt — it's a verification loop)
    const token = await tokenEmailedTo(MEMBER_EMAIL);
    expect(token).toBeTruthy();

    const res = await hostedVerify({ attempt_id: started.attempt_id, token });
    expect(res.status).toBe(200);
    const { link } = (await res.json()) as {
      link: { link_id: string; status: string; member_ref: string; sub_hash: string; programme: string };
    };
    linkId = link.link_id;
    expect(link.status).toBe('active');
    // byte-compatibility with the OAuth path: identical member_ref + sub_hash
    // derivation for the same member (proves "same schema, same T1 behaviour")
    expect(link.sub_hash).toBe(sha256hex(MEMBER));
    expect(link.member_ref).toBe(`mbr_${sha256hex(`${PROGRAMME}:${MEMBER}`).slice(0, 24)}`);
  });

  it('the link + AccountLinked are indistinguishable from OAuth: DB row + ledger + chain verifies', async () => {
    const { rows } = await pool.query<{ status: string; scopes: string }>(
      `SELECT status, scopes::text FROM wallet.identity_links WHERE link_id = $1`,
      [linkId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(JSON.parse(rows[0]!.scopes)).toEqual(['profile', 'balance', 'tier']);

    const linked = await pool.query(`SELECT 1 FROM events.events WHERE type = 'AccountLinked'`);
    expect(linked.rowCount).toBe(1);

    const client = await pool.connect();
    try {
      expect((await verifyChain(client)).ok).toBe(true);
    } finally {
      client.release();
    }
  });

  it('single-use: replaying the same verification token → 401, no second link', async () => {
    const started = (await (
      await hostedStart({ merchant_id: 'mer_00SEEDAVR0RA00000000000000', programme: PROGRAMME, member_ref: 'am_seed_bea', email: 'bea.hosted@example.co.uk' })
    ).json()) as { attempt_id: string };
    const token = await tokenEmailedTo('bea.hosted@example.co.uk');
    expect((await hostedVerify({ attempt_id: started.attempt_id, token })).status).toBe(200);
    expect((await hostedVerify({ attempt_id: started.attempt_id, token })).status).toBe(401);
  });

  it('unverified email → NO link: a wrong token never mints an IdentityLink', async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM wallet.identity_links`)).rows[0] as { n: number };
    const started = (await (
      await hostedStart({ merchant_id: 'mer_00SEEDAVR0RA00000000000000', programme: PROGRAMME, member_ref: 'am_seed_cyn', email: 'cyn.hosted@example.co.uk' })
    ).json()) as { attempt_id: string };
    expect((await hostedVerify({ attempt_id: started.attempt_id, token: 'not-the-emailed-code' })).status).toBe(401);
    const after = (await pool.query(`SELECT count(*)::int AS n FROM wallet.identity_links`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('unknown member number → uniform response, no email, no redeemable attempt', async () => {
    const started = (await (
      await hostedStart({ merchant_id: 'mer_00SEEDAVR0RA00000000000000', programme: PROGRAMME, member_ref: 'am_seed_ghost', email: 'ghost.hosted@example.co.uk' })
    ).json()) as { attempt_id: string; verification_sent: boolean };
    // identical shape — no oracle for member existence
    expect(started.verification_sent).toBe(true);
    // but no email was sent and no attempt is redeemable
    expect(await tokenEmailedTo('ghost.hosted@example.co.uk')).toBeNull();
    expect((await hostedVerify({ attempt_id: started.attempt_id, token: 'anything' })).status).toBe(401);
  });

  it('hosted routes require a session (authn on every route)', async () => {
    expect((await fetch(`${walletUrl}/v1/links/hosted/start`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${walletUrl}/v1/links/hosted/verify`, { method: 'POST' })).status).toBe(401);
  });
});
