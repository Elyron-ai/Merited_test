import { createHmac } from 'node:crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  newId,
  pence,
  webhookSignaturePayload,
  type FakeShopOrderWebhook,
  type Merchant,
  type MerchantCommercial,
} from '@merited/contracts';
import { activeTraceId, withSpan } from '@merited/otel';
import { FakeCrypter, FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import { InMemoryRateLimiter } from './rate-limiter/in-memory.js';
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { OfferPublisher } from '../offers/publisher.js';
import { OffersRepository } from '../offers/repository.js';
import { OffersService } from '../offers/service.js';
import { TrioCommitmentsClient } from '../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../token-client/client.js';
import { createCoreServer, type CoreServer } from '../../server.js';
import { GradeBOrderProcessor } from './grade-b/processor.js';
import { registerGradeBWebhook } from './grade-b/routes.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_m6_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'mer6-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let app: CoreServer;
let baseUrl: string;
let merchant: Merchant;
let webhookSecret: string;
let mintToken: () => Promise<string>;
const authLogs: Array<Record<string, unknown>> = [];

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const webhookFor = (token: string, number: number): FakeShopOrderWebhook => ({
  event: 'order.confirmed',
  shop_domain: 'aurora.fakeshop.test',
  order: {
    number,
    placed_at: iso(5),
    total: { amount_minor: 8450, currency_code: 'GBP' },
    attribution: { merited_token: token },
    lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
  },
});

const deliver = async (payload: FakeShopOrderWebhook, opts: { badSignature?: boolean } = {}) => {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', opts.badSignature ? 'whsec_wrong' : webhookSecret)
    .update(webhookSignaturePayload(timestamp, raw), 'utf8')
    .digest('hex');
  return fetch(`${baseUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
      [IDEMPOTENCY_KEY_HEADER]: `order-${payload.order.number}`,
      // traceparent arrives via undici auto-instrumentation (@merited/otel);
      // a manual header here would double-inject and corrupt extraction
    },
    body: raw,
  });
};

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
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const trioUrl = await trio.listen();

  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('mer6-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const created = await merchants.create({ name: 'Aurora Experiences', commercial });
  await merchants.requestSigningKey(created.merchant_id);
  merchant = await merchants.get(created.merchant_id);
  webhookSecret = (await merchants.issueWebhookSecret(merchant.merchant_id)).secret;

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
      session_nonce: 'mer6',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    if (!minted.ok) throw new Error(minted.error.code);
    return minted.minted.token;
  };

  app = createCoreServer();
  registerGradeBWebhook(app, {
    pool,
    merchants,
    limiter: new InMemoryRateLimiter({ limit: 100, windowS: 3600 }),
    processor: new GradeBOrderProcessor({
      pool,
      signer: new FakeSigner(SIGNER_SECRET),
      trioBaseUrl: trioUrl,
      trioServiceToken: SERVICE_TOKEN,
    }),
    logger: { warn: (payload) => void authLogs.push(payload) },
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

describe('under-reporting instrumentation (MER-6 accept — the B19 data contract)', () => {
  it('(a) accepted intake ALWAYS emits ConversionClaimed — even when the verdict is rejected', async () => {
    const token = await mintToken();
    const verified = await deliver(webhookFor(token, 7001));
    expect((await verified.json() as { verdict: string }).verdict).toBe('verified');
    // replay the SAME token in a new order: accepted intake, rejected verdict
    const replayed = await deliver(webhookFor(token, 7002));
    expect(await replayed.json()).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });

    const events = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'ConversionClaimed'`,
    );
    expect(Number(events.rows[0].count)).toBe(2); // both intakes, one of them rejected
  });

  it('(b) mints minus claims per merchant per day is computable from EVENTS ALONE', async () => {
    await mintToken(); // two mints that never convert — the under-reporting signal
    await mintToken();
    const { rows } = await pool.query<{ merchant_id: string; day: string; mints: string; claims: string }>(
      `WITH cor_merchant AS (
         SELECT body->'data'->'commitment'->>'commitment_id' AS cid,
                body->'data'->'commitment'->>'merchant_id' AS merchant_id
           FROM events.events WHERE type = 'CommitmentCreated'
       ),
       mints AS (
         SELECT cm.merchant_id, date_trunc('day', e.created_at) AS day, count(*) AS n
           FROM events.events e
           JOIN cor_merchant cm ON cm.cid = e.body->'data'->'claims'->>'cid'
          WHERE e.type = 'TokenMinted'
          GROUP BY 1, 2
       ),
       claims AS (
         SELECT body->'data'->>'merchant_id' AS merchant_id,
                date_trunc('day', created_at) AS day, count(*) AS n
           FROM events.events WHERE type = 'ConversionClaimed'
          GROUP BY 1, 2
       )
       SELECT m.merchant_id, m.day::text AS day, m.n AS mints, COALESCE(c.n, 0) AS claims
         FROM mints m LEFT JOIN claims c USING (merchant_id, day)`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.merchant_id).toBe(merchant.merchant_id);
    expect(Number(rows[0]!.mints)).toBe(3); // one claimed twice + two silent
    expect(Number(rows[0]!.claims)).toBe(2); // intakes count, rejected replays included
    expect(Number(rows[0]!.mints) - Number(rows[0]!.claims)).toBe(1); // the gap B19 monitors
  });

  it('(c) signature-rejected deliveries: structured log with slug/reason/traceparent, NO ledger row', async () => {
    const token = await mintToken(); // mint first — its TokenMinted is not the delivery's doing
    const before = await pool.query(`SELECT count(*) FROM events.events`);
    let callerTraceId = '';
    await withSpan('bad-signature-delivery', async () => {
      callerTraceId = activeTraceId()!;
      const res = await deliver(webhookFor(token, 7003), { badSignature: true });
      expect(res.status).toBe(401);
    });
    const after = await pool.query(`SELECT count(*) FROM events.events`);
    // the mint above emitted TokenMinted; the REJECTED DELIVERY itself adds nothing
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count));
    const entry = authLogs.find((l) => l['reason'] === 'bad_signature');
    expect(entry).toMatchObject({ merchant_slug: merchant.slug, reason: 'bad_signature' });
    // the logged traceparent must CORRELATE: it carries the caller's trace ID
    // (injected on the wire by undici auto-instrumentation), so the rejected
    // delivery is findable from the caller's trace (B19).
    expect(entry!['traceparent']).toMatch(
      new RegExp(`^00-${callerTraceId}-[0-9a-f]{16}-[0-9a-f]{2}$`),
    );
  });
});
