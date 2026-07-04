import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeShopOrderWebhook,
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignaturePayload,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue.js';
import { createFakeShop } from './server.js';

const SECRET = 'whsec_fakeshop-test';

interface CapturedDelivery {
  raw: string;
  headers: Record<string, string | string[] | undefined>;
}

let adapter: Server;
let adapterUrl: string;
let deliveries: CapturedDelivery[] = [];
let respondWith: number[] = []; // per-attempt status codes; empty → 200
let shop: FastifyInstance;

beforeAll(async () => {
  adapter = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      deliveries.push({ raw, headers: req.headers });
      const status = respondWith.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  await new Promise<void>((resolve) => adapter.listen(0, '127.0.0.1', resolve));
  adapterUrl = `http://127.0.0.1:${(adapter.address() as { port: number }).port}/webhook`;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl,
    webhookSecret: SECRET,
  });
  await shop.ready();
});

afterEach(() => {
  deliveries = [];
  respondWith = [];
});

afterAll(async () => {
  await shop.close();
  adapter.close();
});

describe('FakeShop storefront (MER-11 accept)', () => {
  it('GET /skus serves the 5 seeded SKUs including the £84.50 spa day', async () => {
    const res = await shop.inject({ method: 'GET', url: '/skus' });
    expect(res.statusCode).toBe(200);
    const { skus } = res.json();
    expect(skus).toHaveLength(5);
    expect(skus).toContainEqual({ sku: 'sku_spa_day', name: 'Full spa day', price_pence: 8450 });
    expect(CATALOGUE.every((s) => Number.isInteger(s.price_pence))).toBe(true);
  });

  it('checkout with a token → exactly ONE signed webhook delivery, verifiable end to end', async () => {
    const res = await shop.inject({
      method: 'POST',
      url: '/checkout',
      payload: { sku: 'sku_spa_day', attribution_token: 'v4.public.fake.tok.sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'confirmed', total_pence: 8450, webhook: 'delivered' });

    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    // signature verifies over the shared timestamp.body layout
    const timestamp = Number(delivery.headers[WEBHOOK_TIMESTAMP_HEADER]);
    const expected = createHmac('sha256', SECRET)
      .update(webhookSignaturePayload(timestamp, delivery.raw), 'utf8')
      .digest('hex');
    expect(delivery.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expected);
    // idempotency key = order number; traceparent forwarded (§8 one trace)
    const payload = FakeShopOrderWebhook.parse(JSON.parse(delivery.raw));
    expect(delivery.headers[IDEMPOTENCY_KEY_HEADER]).toBe(String(payload.order.number));
    // trace forwarding is otel-instrumentation's job (proven in MER-12's e2e)
    expect(payload.order.attribution.merited_token).toBe('v4.public.fake.tok.sig');
    expect(payload.order.total.amount_minor).toBe(8450);
  });

  it('checkout WITHOUT a token still completes and emits — the adapter decides claim-worthiness', async () => {
    const res = await shop.inject({
      method: 'POST',
      url: '/checkout',
      payload: { sku: 'sku_candle' },
    });
    expect(res.statusCode).toBe(200);
    expect(deliveries).toHaveLength(1);
    const payload = FakeShopOrderWebhook.parse(JSON.parse(deliveries[0]!.raw));
    expect(payload.order.attribution.merited_token).toBeNull();
  });

  it('retries with backoff reuse the SAME idempotency key (MER-3 replay rehearsal)', async () => {
    respondWith = [500, 503]; // two failures, then default 200
    const res = await shop.inject({
      method: 'POST',
      url: '/checkout',
      payload: { sku: 'sku_lunch', attribution_token: 'tok' },
    });
    expect(res.json().webhook).toBe('delivered');
    expect(deliveries).toHaveLength(3);
    const keys = new Set(deliveries.map((d) => d.headers[IDEMPOTENCY_KEY_HEADER]));
    expect(keys.size).toBe(1);
  });

  it('FAKESHOP_DROP_WEBHOOK_PCT: dropped deliveries never reach the adapter, checkout still confirms', async () => {
    const dropper = createFakeShop({
      shopDomain: 'aurora.fakeshop.test',
      adapterUrl,
      webhookSecret: SECRET,
      dropWebhookPct: 100,
      random: () => 0, // always below the threshold → always drop
    });
    await dropper.ready();
    const res = await dropper.inject({
      method: 'POST',
      url: '/checkout',
      payload: { sku: 'sku_spa_day', attribution_token: 'tok' },
    });
    expect(res.json()).toMatchObject({ status: 'confirmed', webhook: 'dropped' });
    expect(deliveries).toHaveLength(0);
    await dropper.close();
  });

  it('unknown sku → 404; malformed body → 400', async () => {
    expect((await shop.inject({ method: 'POST', url: '/checkout', payload: { sku: 'sku_nope' } })).statusCode).toBe(404);
    expect((await shop.inject({ method: 'POST', url: '/checkout', payload: { qty: -1 } })).statusCode).toBe(400);
  });

  it('P5 hygiene: zero imports from apps/core or the trio anywhere in the shop', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const shipped = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(shipped.length).toBeGreaterThanOrEqual(3);
    for (const file of shipped) {
      const source = readFileSync(path.join(here, file), 'utf8');
      expect(source).not.toMatch(/@merited\/(core|trio)|apps\/(core|trio)/);
    }
  });
});
