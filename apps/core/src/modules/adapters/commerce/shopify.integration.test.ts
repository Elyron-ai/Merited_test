import { createHmac } from 'node:crypto';
import {
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_TOKEN_ATTRIBUTE,
  SHOPIFY_TOPIC_HEADER,
  SHOPIFY_WEBHOOK_ID_HEADER,
  newId,
  pence,
  type Merchant,
  type MerchantCommercial,
  type ShopifyOrdersPaid,
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
import { MerchantsService } from '../../merchants/service.js';
import { TrioKeysClient } from '../../merchants/trio-keys-client.js';
import { OfferPublisher } from '../../offers/publisher.js';
import { OffersRepository } from '../../offers/repository.js';
import { OffersService } from '../../offers/service.js';
import { TrioCommitmentsClient } from '../../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../../token-client/client.js';
import { registerShopifyOrdersPaidRoute } from './routes.js';

/**
 * PH3-5 accept (the CI-provable legs): "checkout carrying the token in the
 * cart attribute → orders/paid → signed claim → verified; order without a
 * token produces no claim; webhook signature verification on even in dev."
 * The route is exercised with Shopify-NATIVE deliveries (base64 HMAC, shop
 * domain + webhook id headers, decimal-string money) against the simulated
 * trio with real minted tokens. The DEV-STORE run of the same path is
 * launch-readiness A12 (LEAD-3).
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_shpfy_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'shopify-test';
const SIGNER_SECRET = 'trio-test-secret';
const SHOP_DOMAIN = 'aurora-experiences.myshopify.com';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let app: CoreServer;
let baseUrl: string;
let merchant: Merchant;
let secret: string;
let mintToken: () => Promise<string>;
let orderId = 900000;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const orderFor = (token: string | null): ShopifyOrdersPaid => {
  orderId += 1;
  return {
    id: orderId,
    order_number: orderId,
    total_price: '84.50',
    currency: 'GBP',
    processed_at: iso(0),
    note_attributes: token === null ? [] : [{ name: SHOPIFY_TOKEN_ATTRIBUTE, value: token }],
    line_items: [{ sku: 'sku_spa_day', quantity: 1, price: '84.50' }],
  };
};

const shopifyHeaders = (
  rawBody: string,
  opts: { secretOverride?: string; webhookId?: string; domain?: string } = {},
) => ({
  'content-type': 'application/json',
  [SHOPIFY_HMAC_HEADER]: createHmac('sha256', opts.secretOverride ?? secret)
    .update(rawBody, 'utf8')
    .digest('base64'),
  [SHOPIFY_SHOP_DOMAIN_HEADER]: opts.domain ?? SHOP_DOMAIN,
  [SHOPIFY_TOPIC_HEADER]: 'orders/paid',
  [SHOPIFY_WEBHOOK_ID_HEADER]: opts.webhookId ?? `whid-${Math.random().toString(36).slice(2)}`,
});

const intakeUrl = (slug: string) => `${baseUrl}/v1/merchants/${slug}/shopify/orders-paid`;

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
    new FakeCrypter('shopify-crypter'),
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
      session_nonce: 'shopify-test',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    if (!minted.ok) throw new Error(minted.error.code);
    return minted.minted.token;
  };

  app = createCoreServer();
  registerShopifyOrdersPaidRoute(app, {
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

describe('Shopify orders/paid intake (PH3-5 accept, CI legs)', () => {
  it('cart-attribute token → orders/paid → signed claim → VERIFIED, original qid/jti intact', async () => {
    const token = await mintToken();
    const tokenClaims = decodeTokenClaims(token)!;
    const raw = JSON.stringify(orderFor(token));
    const response = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(raw),
      body: raw,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.verdict).toBe('verified');

    // the decimal-string £84.50 landed as integer 8450 pence, and the claim
    // carries the ORIGINAL mint identifiers (accept clause)
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

  it('P2: an order with NO merited_token attribute → 200 ignored, NO claim row', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    const raw = JSON.stringify(orderFor(null));
    const response = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(raw),
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'ignored', reason: 'TOKEN_ABSENT' });
    const after = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('§8: bad HMAC / unknown merchant → uniform 401 even in dev; nothing processed', async () => {
    const raw = JSON.stringify(orderFor(await mintToken()));
    const badSig = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(raw, { secretOverride: 'shpss_wrong' }),
      body: raw,
    });
    expect(badSig.status).toBe(401);

    const unsigned = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SHOPIFY_WEBHOOK_ID_HEADER]: 'x' },
      body: raw,
    });
    expect(unsigned.status).toBe(401);

    const unknown = await fetch(intakeUrl('no-such-store'), {
      method: 'POST',
      headers: shopifyHeaders(raw),
      body: raw,
    });
    expect(unknown.status).toBe(401);
  });

  it('a redelivered webhook id → byte-identical replay, ONE claim', async () => {
    const token = await mintToken();
    const raw = JSON.stringify(orderFor(token));
    const first = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(raw, { webhookId: 'whid-static-dup' }),
      body: raw,
    });
    const firstText = await first.text();
    expect(first.status).toBe(200);
    const claimId = (JSON.parse(firstText) as { claim_id: string }).claim_id;

    const replay = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(raw, { webhookId: 'whid-static-dup' }),
      body: raw,
    });
    expect(await replay.text()).toBe(firstText);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM core.claims_intake WHERE claim_id = $1`,
      [claimId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('missing webhook id → 400; missing shop domain → 400; junk body → 400', async () => {
    const raw = JSON.stringify(orderFor(null));
    const { [SHOPIFY_WEBHOOK_ID_HEADER]: _id, ...withoutId } = shopifyHeaders(raw);
    const missingId = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: withoutId,
      body: raw,
    });
    expect(missingId.status).toBe(400);

    const { [SHOPIFY_SHOP_DOMAIN_HEADER]: _d, ...withoutDomain } = shopifyHeaders(raw);
    const missingDomain = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: withoutDomain,
      body: raw,
    });
    expect(missingDomain.status).toBe(400);

    const junk = '{"id": "not-a-shopify-order"}';
    const malformed = await fetch(intakeUrl(merchant.slug), {
      method: 'POST',
      headers: shopifyHeaders(junk),
      body: junk,
    });
    expect(malformed.status).toBe(400);
  });
});
