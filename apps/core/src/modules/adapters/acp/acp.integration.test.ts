import { createHmac } from 'node:crypto';
import {
  ACP_EXPIRES_KEY,
  ACP_QUOTE_KEY,
  ACP_TOKEN_KEY,
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  newId,
  pence,
  webhookSignaturePayload,
  type AcpOrderWebhook,
  type Merchant,
  type MerchantCommercial,
} from '@merited/contracts';
import { FakeCrypter, FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../../trio/scripts/migrate.mjs';
import { createCoreServer, type CoreServer } from '../../../server.js';
import { InMemoryRateLimiter } from '../rate-limiter/in-memory.js';
import { decodeTokenClaims } from '../grade-b/claim-builder.js';
import { GradeBOrderProcessor } from '../grade-b/processor.js';
import { protocolConformanceSuite } from '../protocol/harness.js';
import { MerchantsService } from '../../merchants/service.js';
import { TrioKeysClient } from '../../merchants/trio-keys-client.js';
import { OfferPublisher } from '../../offers/publisher.js';
import { OffersRepository } from '../../offers/repository.js';
import { OffersService } from '../../offers/service.js';
import { TrioCommitmentsClient } from '../../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../../token-client/client.js';
import { AcpAdapter } from './adapter.js';
import { registerAcpOrderRoute } from './routes.js';

/**
 * PH3-4 accept: "same conformance round-trip as PH3-3 for ACP" — the PH3-2
 * suite re-runs against the REAL adapter, then the intake route is
 * exercised end-to-end against the simulated trio with real minted tokens:
 * callback → ConversionClaim → verified with the original qid/jti intact;
 * a callback missing the token produces no claim (P2).
 */

// ——— the PH3-2 suite against the real adapter (same fixtures as the stub run)
protocolConformanceSuite('ACP (real adapter, PH3-4)', () => ({
  adapter: new AcpAdapter(),
  tokenFieldOf: (out) => out.metadata[ACP_TOKEN_KEY],
  callbackWith: (token, orderRef, grossPence) => ({
    object: 'acp.order' as const,
    id: 'acp_ord_real_0001',
    order_ref: orderRef,
    amount_minor: grossPence,
    currency: 'gbp' as const,
    created_at: '2026-07-05T12:05:00Z',
    line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
    metadata: token ? { [ACP_TOKEN_KEY]: token } : {},
  }),
  callbackWithSmuggledToken: (token, orderRef, grossPence) => ({
    object: 'acp.order' as const,
    id: 'acp_ord_real_0002',
    order_ref: orderRef,
    amount_minor: grossPence,
    currency: 'gbp' as const,
    created_at: '2026-07-05T12:05:00Z',
    line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
    metadata: { someone_elses_key: token, 'merited:notes': token }, // NOT merited:token
  }),
  serialise: (payload) => JSON.stringify(payload),
}));

// ——— the intake route, full path: signed callback → adapter → processor → trio

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_acp_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'acp-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let app: CoreServer;
let baseUrl: string;
let merchant: Merchant;
let secret: string;
let mintToken: () => Promise<string>;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const callbackFor = (token: string | null, orderRef: string): AcpOrderWebhook => ({
  object: 'acp.order',
  id: `acp_ord_${orderRef}`,
  order_ref: orderRef,
  amount_minor: 8450,
  currency: 'gbp',
  created_at: iso(0),
  line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
  metadata:
    token === null
      ? {}
      : { [ACP_TOKEN_KEY]: token, [ACP_QUOTE_KEY]: 'qte_acp_echo', [ACP_EXPIRES_KEY]: iso(600) },
});

const signedHeaders = (rawBody: string, opts: { secretOverride?: string; key?: string } = {}) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', opts.secretOverride ?? secret)
      .update(webhookSignaturePayload(timestamp, rawBody), 'utf8')
      .digest('hex'),
    [IDEMPOTENCY_KEY_HEADER]: opts.key ?? `acp-${Math.random().toString(36).slice(2)}`,
  };
};

const intakeUrl = (slug: string) => `${baseUrl}/v1/merchants/${slug}/acp/order-completed`;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();

  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('acp-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const created = await merchants.create({ name: 'Aurora Experiences', commercial });
  await merchants.requestSigningKey(created.merchant_id);
  merchant = await merchants.get(created.merchant_id);
  secret = (await merchants.issueWebhookSecret(merchant.merchant_id)).secret;

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    merchantFor: (id) => merchants.get(id),
  });
  const offer = await offers.createDraft({
    merchant_id: merchant.merchant_id,
    title: 'Spa day',
    description: 'Spa day',
    mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
    sku_scope: ['sku_spa_day'],
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
  });
  const published = await publisher.publish(offer.offer_id, {
    bounty: { type: 'fixed', amount: pence(1200) },
  });
  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  mintToken = async () => {
    const minted = await tokenClient.mint({
      cid: published.commitment_id as `com_${string}`,
      qid: newId('qte'),
      aid: newId('agt'),
      tier: 'T3',
      session_nonce: 'acp-test',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    if (!minted.ok) throw new Error(minted.error.code);
    return minted.minted.token;
  };

  app = createCoreServer();
  registerAcpOrderRoute(app, {
    pool,
    merchants,
    limiter: new InMemoryRateLimiter({ limit: 1000, windowS: 3600 }),
    processor: new GradeBOrderProcessor({
      pool,
      signer: new FakeSigner(SIGNER_SECRET),
      trioBaseUrl: trioUrl,
      trioServiceToken: SERVICE_TOKEN,
    }),
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('ACP order-callback intake (PH3-4 accept)', () => {
  it('signed callback with the token → ConversionClaim VERIFIED, original qid/jti intact', async () => {
    const token = await mintToken();
    const tokenClaims = decodeTokenClaims(token)!;
    const raw = JSON.stringify(callbackFor(token, 'acp-order-happy-1'));
    const response = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: signedHeaders(raw),
      body: raw,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.verdict).toBe('verified');

    // the claim carries the ORIGINAL mint identifiers — the protocol hop
    // neither re-minted nor re-quoted (accept clause)
    const intake = await pool.query(
      `SELECT verdict, jti, qid, cid, gross_pence FROM core.claims_intake WHERE claim_id = $1`,
      [body.claim_id],
    );
    expect(intake.rows[0]).toEqual({
      verdict: 'verified',
      jti: tokenClaims.jti,
      qid: tokenClaims.qid,
      cid: tokenClaims.cid,
      gross_pence: 8450,
    });
  });

  it('P2: a callback with NO merited:token key → 200 ignored, NO claim row', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    const raw = JSON.stringify(callbackFor(null, 'acp-order-anon-1'));
    const response = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: signedHeaders(raw),
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored', reason: 'TOKEN_ABSENT' });
    const after = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a token under any OTHER metadata key is IGNORED on the wire too', async () => {
    const token = await mintToken();
    const smuggled = callbackFor(null, 'acp-order-smuggle-1');
    smuggled.metadata['merited:notes'] = token;
    smuggled.metadata['someone_elses_key'] = token;
    const raw = JSON.stringify(smuggled);
    const response = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: signedHeaders(raw),
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored', reason: 'TOKEN_ABSENT' });
  });

  it('bad signature / unknown merchant → uniform 401; nothing processed', async () => {
    const raw = JSON.stringify(callbackFor(await mintToken(), 'acp-order-bad-sig-1'));
    const badSig = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: signedHeaders(raw, { secretOverride: 'whsec_wrong' }),
      body: raw,
    });
    expect(badSig.status).toBe(401);

    const unknown = await fetch(intakeUrl('no-such-merchant'), {
      method: 'POST',
      headers: signedHeaders(raw),
      body: raw,
    });
    expect(unknown.status).toBe(401);

    const orphan = await pool.query(
      `SELECT count(*)::int AS n FROM core.claims_intake WHERE order_ref_hash = encode(sha256('acp-order-bad-sig-1'::bytea), 'hex')`,
    );
    expect(orphan.rows[0].n).toBe(0);
  });

  it('duplicate delivery (same Idempotency-Key) → byte-identical replay, ONE claim', async () => {
    const token = await mintToken();
    const raw = JSON.stringify(callbackFor(token, 'acp-order-dup-1'));
    const headers = signedHeaders(raw, { key: 'acp-dup-static' });
    const first = await fetch(intakeUrl(merchant.slug), { method: 'POST', headers, body: raw });
    const firstText = await first.text();
    expect(first.status).toBe(200);

    const replay = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: signedHeaders(raw, { key: 'acp-dup-static' }),
      body: raw,
    });
    expect(await replay.text()).toBe(firstText);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM core.claims_intake WHERE order_ref_hash = encode(sha256('acp-order-dup-1'::bytea), 'hex')`,
    );
    expect(rows.rows[0].n).toBe(1);
  });
});
