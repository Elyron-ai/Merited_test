import { createHmac } from 'node:crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignaturePayload,
  type FakeShopOrderWebhook,
  type MerchantCommercial,
} from '@merited/contracts';
import { deliverOrderWebhook } from '@merited/fake-aurora';
import { FakeCrypter } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
import { InMemoryRateLimiter } from '../../adapters/rate-limiter/in-memory.js';
import { MerchantsService } from '../../merchants/service.js';
import { createCoreServer, type CoreServer } from '../../../server.js';
import { registerGradeBWebhook } from './routes.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_gb_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let app: CoreServer;
let baseUrl: string;
let merchants: MerchantsService;
let slug: string;
let secret: string;
let processed: FakeShopOrderWebhook[] = [];
let authFailures: Array<Record<string, unknown>> = [];

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const orderPayload = (number: number): FakeShopOrderWebhook => ({
  event: 'order.confirmed',
  shop_domain: 'aurora.fakeshop.test',
  order: {
    number,
    placed_at: '2026-07-04T12:00:00Z',
    total: { amount_minor: 8450, currency_code: 'GBP' },
    attribution: { merited_token: 'v4.public.fake.tok.sig' },
    lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
  },
});

const signedHeaders = (rawBody: string, opts: { secretOverride?: string; ageS?: number } = {}) => {
  const timestamp = Math.floor(Date.now() / 1000) - (opts.ageS ?? 0);
  return {
    'content-type': 'application/json',
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', opts.secretOverride ?? secret)
      .update(webhookSignaturePayload(timestamp, rawBody), 'utf8')
      .digest('hex'),
    [IDEMPOTENCY_KEY_HEADER]: 'order-key-static',
  };
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  merchants = new MerchantsService(pool, new FakeCrypter('grade-b-crypter'), {
    issueMerchantKey: async () => ({ signing_key_ref: 'merchant/unused', public_key: 'pk' }),
  });
  const merchant = await merchants.create({ name: 'Aurora Experiences', commercial });
  slug = merchant.slug;
  secret = (await merchants.issueWebhookSecret(merchant.merchant_id)).secret;

  app = createCoreServer();
  registerGradeBWebhook(app, {
    pool,
    merchants,
    limiter: new InMemoryRateLimiter({ limit: 30, windowS: 3600 }),
    processor: {
      processOrder: async (payload) => {
        processed.push(payload);
        return { status: 200, body: { verdict: 'accepted', order: payload.order.number } };
      },
    },
    logger: { warn: (payload) => void authFailures.push(payload) },
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

beforeEach(() => {
  processed = [];
  authFailures = [];
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const webhookUrl = () => `${baseUrl}/v1/merchants/${slug}/webhooks/order-confirmed`;

describe('Grade-B webhook endpoint (MER-3 accept)', () => {
  it('wire compatibility: FakeShop’s own sender delivers and is accepted first try', async () => {
    const result = await deliverOrderWebhook(orderPayload(9001), {
      adapterUrl: webhookUrl(),
      secret,
      idempotencyKey: 'order-9001',
    });
    expect(result).toEqual({ delivered: true, attempts: 1 });
    expect(processed).toHaveLength(1);
    expect(processed[0]!.order.number).toBe(9001);
  });

  it('unsigned / badly-signed / stale-timestamp → 401, structured log, processor never runs', async () => {
    const raw = JSON.stringify(orderPayload(9002));

    const unsigned = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'k' },
      body: raw,
    });
    expect(unsigned.status).toBe(401);

    const badlySigned = await fetch(webhookUrl(), {
      method: 'POST',
      headers: signedHeaders(raw, { secretOverride: 'whsec_wrong-secret' }),
      body: raw,
    });
    expect(badlySigned.status).toBe(401);

    const stale = await fetch(webhookUrl(), {
      method: 'POST',
      headers: signedHeaders(raw, { ageS: 400 }), // beyond the 300s skew
      body: raw,
    });
    expect(stale.status).toBe(401);

    const unknownSlug = await fetch(
      `${baseUrl}/v1/merchants/no-such-shop/webhooks/order-confirmed`,
      { method: 'POST', headers: signedHeaders(raw), body: raw },
    );
    expect(unknownSlug.status).toBe(401); // uniform — no slug enumeration

    expect(processed).toHaveLength(0);
    expect(authFailures.map((f) => f['reason'])).toEqual([
      'missing_signature',
      'bad_signature',
      'stale_timestamp',
      'merchant_unknown',
    ]);
  });

  it('duplicate delivery with the same key → byte-identical response, processor runs EXACTLY once', async () => {
    const raw = JSON.stringify(orderPayload(9003));
    const headers = signedHeaders(raw);
    const first = await fetch(webhookUrl(), { method: 'POST', headers, body: raw });
    const firstText = await first.text();
    expect(first.status).toBe(200);

    const replay = await fetch(webhookUrl(), { method: 'POST', headers: signedHeaders(raw), body: raw });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstText); // verbatim
    expect(processed).toHaveLength(1); // exactly one claim submission

    // same key, different body → 422 conflict
    const different = JSON.stringify(orderPayload(9004));
    const conflict = await fetch(webhookUrl(), {
      method: 'POST',
      headers: signedHeaders(different),
      body: different,
    });
    expect(conflict.status).toBe(422);
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('secret rotation: the OLD secret keeps verifying until revoked (SYN-39 overlap)', async () => {
    const merchant = await merchants.getBySlug(slug);
    const rotated = await merchants.issueWebhookSecret(merchant.merchant_id);
    const raw = JSON.stringify(orderPayload(9005));

    const viaOld = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { ...signedHeaders(raw), [IDEMPOTENCY_KEY_HEADER]: 'rot-old' },
      body: raw,
    });
    expect(viaOld.status).toBe(200);

    const viaNew = await fetch(webhookUrl(), {
      method: 'POST',
      headers: {
        ...signedHeaders(raw, { secretOverride: rotated.secret }),
        [IDEMPOTENCY_KEY_HEADER]: 'rot-new',
      },
      body: raw,
    });
    expect(viaNew.status).toBe(200);
  });

  it('missing idempotency key → 400; malformed payload → 400; rate-limit breach → 429', async () => {
    const raw = JSON.stringify(orderPayload(9006));
    const { [IDEMPOTENCY_KEY_HEADER]: _k, ...withoutKey } = signedHeaders(raw);
    const missingKey = await fetch(webhookUrl(), { method: 'POST', headers: withoutKey, body: raw });
    expect(missingKey.status).toBe(400);

    const junk = '{"event":"order.confirmed","order":{}}';
    const malformed = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { ...signedHeaders(junk), [IDEMPOTENCY_KEY_HEADER]: 'junk-1' },
      body: junk,
    });
    expect(malformed.status).toBe(400);

    let denied = false;
    for (let i = 0; i < 40 && !denied; i += 1) {
      const body = JSON.stringify(orderPayload(9100 + i));
      const res = await fetch(webhookUrl(), {
        method: 'POST',
        headers: { ...signedHeaders(body), [IDEMPOTENCY_KEY_HEADER]: `burst-${i}` },
        body,
      });
      denied = res.status === 429;
    }
    expect(denied).toBe(true);
  });
});
