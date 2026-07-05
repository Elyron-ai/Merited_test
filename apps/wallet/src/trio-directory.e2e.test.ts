import { createServer } from 'node:http';
import {
  FIXTURE_IDS,
  newId,
  pence,
  type CommitmentDraft,
  type MandateGrantRequest,
  type VerifyRequest,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { TrioCommitmentsClient, TrioTokenClient } from '@merited/core';
import { HttpDirectory, VerifiedDirectory } from '@merited/trio';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { FakeSigner } from '@merited/signing';
import { type FastifyInstance } from 'fastify';
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
import { migrateWallet } from '../scripts/migrate.mjs';
import { SmtpMailer } from './lib/mailer/smtp.js';
import { buildWalletServer } from './server.js';

/**
 * TRIO-17 accept: B14/B26 accepts pass END-TO-END VIA THE TRIO with the LIVE
 * directory — the trio's `HttpDirectory` resolves approvals/mandates from the
 * wallet's `/internal/directory/*` routes at claim time (attestations still
 * verified before trust; the wallet re-attests mandates over CURRENT state).
 * Mid-session revocation → `MANDATE_REVOKED` on the next claim; live check,
 * no cache window. No pipeline changes — the port was designed for the swap.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const dbName = `merited_t17_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 't17-trio-token';
const DIRECTORY_TOKEN = 't17-directory-token';
// ONE platform signer identity: wallet attests, trio verifies
const signer = new FakeSigner('t17-secret');

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let wallet: FastifyInstance;
let walletUrl: string;
let cookie: string;
let consumerRef: string;
let tokenClient: TrioTokenClient;
let commitmentId: `com_${string}`;

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const grantReq = (): MandateGrantRequest => ({
  agent_id: FIXTURE_IDS.agent,
  scopes: ['offers:read', 'checkout:execute'],
  limits: { per_txn: pence(10000), per_month: pence(50000), categories: ['experiences'] },
  merchants: ['*'],
  data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
  pre_authorised_up_to: pence(2000),
  exp: iso(30 * 86400),
});

const insertQuote = async (): Promise<string> => {
  const quoteId = newId('qte');
  await pool.query(
    `INSERT INTO core.quotes
       (quote_id, offer_id, commitment_id, agent_id, consumer_ref, tier, segment,
        list_amount, final_amount, currency, mechanics_applied, token_jti,
        expires_at, created_at, inputs_snapshot)
     VALUES ($1,$2,$3,$4,$5,'T1','t1-member-new',8450,8450,'GBP_pence','[]',NULL,$6,now(),'{}')`,
    [quoteId, FIXTURE_IDS.offer, commitmentId, FIXTURE_IDS.agent, consumerRef, iso(300)],
  );
  return quoteId;
};

const approveViaWallet = async (quoteId: string, mandateId: string) =>
  (await (
    await fetch(`${walletUrl}/v1/quotes/${quoteId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mandate_id: mandateId }),
    })
  ).json()) as { approval?: { approval_id: string }; token?: string; error?: { code: string } };

const signedClaim = async (token: string, grossPence = 8450): Promise<VerifyRequest> => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: FIXTURE_IDS.merchant,
    attribution_token: token,
    order: {
      order_ref_hash: 'b'.repeat(64),
      gross_value: pence(grossPence),
      ts: iso(10),
    },
  };
  const merchant_sig = await signer.sign(`merchant/${base.merchant_id}`, canonicalJson(base));
  return { ...base, merchant_sig } as VerifyRequest;
};

const verifyClaim = async (claim: VerifyRequest): Promise<{ verdict: string; reason_code?: string }> => {
  const response = await fetch(`${trioUrl}/trio/claims/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-merited-service-token': SERVICE_TOKEN,
      'idempotency-key': newId('clm'),
    },
    body: JSON.stringify(claim),
  });
  return response.json() as Promise<{ verdict: string; reason_code?: string }>;
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

  // the wallet's port is reserved FIRST so the trio can point its live
  // directory at it before either server listens
  const walletPort = await freePort();
  walletUrl = `http://127.0.0.1:${walletPort}`;

  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 't17-secret',
    directory: new HttpDirectory({ baseUrl: walletUrl, serviceToken: DIRECTORY_TOKEN }),
  });
  trioUrl = await trio.listen();
  tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });

  wallet = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 't17-session',
    verifyBaseUrl: `${walletUrl}/verify`,
    signer,
    directoryServiceToken: DIRECTORY_TOKEN,
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
  });
  await wallet.listen({ port: walletPort, host: '127.0.0.1' });

  const commitments = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const draft: CommitmentDraft = {
    merchant_id: FIXTURE_IDS.merchant,
    offer_ref: FIXTURE_IDS.offer,
    bounty: { type: 'fixed', amount: pence(1200) },
    take_rate_bps: 2000,
    agent_commission_bps: 6000,
    terms: {
      attribution_window_s: 86400,
      eligible_identity_tiers: ['T1', 'T2', 'T3'],
      max_conversions: 500,
      clawback_window_s: 2592000,
      valid_from: iso(-86400),
      valid_until: iso(180 * 86400),
    },
  };
  commitmentId = (await commitments.create(draft)).commitment_id;

  // wallet session (magic-link, recipient-scoped mailbox)
  const email = 't17@example.co.uk';
  await fetch(`${walletUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  const magicToken = new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: magicToken }),
  });
  cookie = verified.headers.get('set-cookie')!.split(';')[0]!;
  consumerRef = ((await (await fetch(`${walletUrl}/v1/me`, { headers: { cookie } })).json()) as { consumer_ref: string }).consumer_ref;
}, 120_000);

afterAll(async () => {
  await wallet.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('live directory wiring (TRIO-17)', () => {
  let mandateId: string;

  it('approve → execute verifies END-TO-END with the trio resolving consent over HTTP (nothing fed by hand)', async () => {
    const { mandate } = (await (
      await fetch(`${walletUrl}/v1/mandates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(grantReq()),
      })
    ).json()) as { mandate: { mandate_id: string } };
    mandateId = mandate.mandate_id;

    const quoteId = await insertQuote();
    const approved = await approveViaWallet(quoteId, mandateId);
    expect(approved.token).toBeTruthy();

    // NOTE: trio.directory (the fixture) is never touched — the pipeline's
    // stage 6 fetches approval + mandate from the wallet, live, per claim
    const verdict = await verifyClaim(await signedClaim(approved.token!));
    expect(verdict).toMatchObject({ verdict: 'verified' });
  });

  it('ACCEPT: mid-session revocation → MANDATE_REVOKED on the NEXT claim (live, no cache window)', async () => {
    // a second quote approved while the mandate is still active
    const quoteId = await insertQuote();
    const approved = await approveViaWallet(quoteId, mandateId);
    expect(approved.token).toBeTruthy();

    // mid-session: the consumer revokes via the wallet…
    const revoked = (await (
      await fetch(`${walletUrl}/v1/mandates/${mandateId}/revoke`, { method: 'POST', headers: { cookie } })
    ).json()) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);

    // …and the VERY NEXT claim — valid approval, token already minted — fails
    const verdict = await verifyClaim(await signedClaim(approved.token!));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'MANDATE_REVOKED' });
  });

  it('the revoked mandate is served RE-ATTESTED: a verified fact, not an unverifiable blob', async () => {
    const response = await fetch(`${walletUrl}/internal/directory/mandates/${mandateId}`, {
      headers: { 'x-merited-service-token': DIRECTORY_TOKEN },
    });
    expect(response.status).toBe(200);
    const { mandate } = (await response.json()) as { mandate: Record<string, unknown> & { status: string; attestation: string } };
    expect(mandate.status).toBe('revoked');
    const { attestation, ...payload } = mandate;
    expect(await signer.verify('platform/attestations', canonicalJson(payload), attestation)).toBe(true);
  });

  it('directory routes fail closed: wrong token → 401; unknown ids → 404; HttpDirectory maps both to null', async () => {
    const noToken = await fetch(`${walletUrl}/internal/directory/mandates/${mandateId}`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${walletUrl}/internal/directory/approvals/apr_x`, {
      headers: { 'x-merited-service-token': 'wrong' },
    });
    expect(wrongToken.status).toBe(401);
    const unknown = await fetch(`${walletUrl}/internal/directory/mandates/mnd_00000000000000000000000000`, {
      headers: { 'x-merited-service-token': DIRECTORY_TOKEN },
    });
    expect(unknown.status).toBe(404);

    const misconfigured = new HttpDirectory({ baseUrl: walletUrl, serviceToken: 'wrong' });
    expect(await misconfigured.getMandate(mandateId)).toBeNull();
    expect(await misconfigured.getApproval('apr_00000000000000000000000000')).toBeNull();
  });

  it('a TAMPERED record from the wire is refused by the verifying wrapper (never trusted)', async () => {
    const honest = new HttpDirectory({ baseUrl: walletUrl, serviceToken: DIRECTORY_TOKEN });
    const stored = await honest.getMandate(mandateId);
    expect(stored).not.toBeNull();

    // a MITM inflating the per-txn limit but keeping the old attestation
    const tampered = new HttpDirectory({
      baseUrl: walletUrl,
      serviceToken: DIRECTORY_TOKEN,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const real = await fetch(url as never, init);
        const body = (await real.json()) as { mandate?: { limits?: { per_txn?: { amount: number } } } };
        if (body.mandate?.limits?.per_txn) body.mandate.limits.per_txn.amount = 99_999_999;
        return new Response(JSON.stringify(body), { status: real.status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const wrapped = new VerifiedDirectory(tampered, signer);
    expect(await wrapped.getMandate(mandateId)).toBeNull(); // fail closed
  });

  it('execute-without-approval still rejects APPROVAL_MISSING through the live directory', async () => {
    const bare = await tokenClient.mint({
      cid: commitmentId,
      qid: newId('qte'),
      aid: FIXTURE_IDS.agent,
      tier: 'T1',
      session_nonce: 't17-no-approval',
      quote: { expires_at: iso(300), mandate_ref: mandateId as `mnd_${string}` },
    });
    if (!bare.ok) throw new Error('negative mint failed');
    const verdict = await verifyClaim(await signedClaim(bare.minted.token));
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'APPROVAL_MISSING' });
  });
});
