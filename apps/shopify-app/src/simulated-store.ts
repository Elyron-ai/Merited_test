import { createHash, createHmac } from 'node:crypto';
import {
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_TOKEN_ATTRIBUTE,
  SHOPIFY_TOPIC_HEADER,
  SHOPIFY_WEBHOOK_ID_HEADER,
  ShopifyOrdersPaid,
  penceToPounds,
} from '@merited/contracts';
import Fastify, { type FastifyInstance } from 'fastify';

interface CheckoutBody {
  sku: string;
  attributes: Record<string, string>;
  qty: number;
}

// native shop-side validation — this simulates an EXTERNAL system (P5, the
// same stance as FakeShop) and deliberately knows no Merited contracts
// beyond the wire constants
const parseCheckoutBody = (body: unknown): CheckoutBody | null => {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record['sku'] !== 'string' || record['sku'].length === 0) return null;
  const qty = record['qty'] === undefined ? 1 : record['qty'];
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) return null;
  const rawAttributes = record['attributes'] === undefined ? {} : record['attributes'];
  if (typeof rawAttributes !== 'object' || rawAttributes === null) return null;
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawAttributes)) {
    if (typeof value !== 'string') return null;
    attributes[name] = value;
  }
  return { sku: record['sku'], attributes, qty };
};

export interface SimulatedStoreSku {
  sku: string;
  name: string;
  price_pence: number;
}

/** The same five Aurora Experiences products FakeShop sells, Shopify-shaped. */
export const STORE_CATALOGUE: readonly SimulatedStoreSku[] = [
  { sku: 'sku_spa_day', name: 'Full spa day', price_pence: 8450 },
  { sku: 'sku_lunch', name: 'Tasting-menu lunch for two', price_pence: 6200 },
  { sku: 'sku_massage', name: 'Hot-stone massage', price_pence: 4500 },
  { sku: 'sku_yoga_class', name: 'Sunrise yoga class', price_pence: 1800 },
  { sku: 'sku_candle', name: 'Aurora signature candle', price_pence: 2400 },
];

export interface SimulatedShopifyStoreOptions {
  shopDomain: string;
  /** The merchant's core intake: `POST …/shopify/orders-paid`. */
  webhookUrl: string;
  /** The delivery-signing secret registered with the merchant in core. */
  webhookSecret: string;
}

/**
 * The Shopify dev-store stand-in (PH3-5): a storefront that behaves like a
 * Shopify shop ON THE WIRE — checkouts carry cart attributes, the order
 * echoes them as note attributes, money is decimal strings, and the
 * `orders/paid` delivery is signed with Shopify's NATIVE scheme (base64
 * HMAC-SHA256 over the raw bytes, `x-shopify-webhook-id` as the delivery
 * id). CI proves the whole Grade-A path against this; the REAL dev-store
 * run (install → checkout → orders/paid) is launch-readiness A12 and needs
 * LEAD-3's store. Like FakeShop, it is dumb and merchant-shaped: token-less
 * checkouts complete and emit like any other order — the adapter decides
 * claim-worthiness, not the shop.
 */
export const createSimulatedShopifyStore = (
  options: SimulatedShopifyStoreOptions,
): FastifyInstance => {
  const app = Fastify();
  let orderSeq = 5000;
  // checkout idempotency (§8): a repeated Idempotency-Key replays the SAME
  // confirmation — one order, one delivery — so a resumed errand never
  // double-buys
  const confirmations = new Map<string, unknown>();

  app.get('/skus', async () => ({ skus: STORE_CATALOGUE }));

  app.post('/checkout', async (req, reply) => {
    const parsed = parseCheckoutBody(req.body);
    if (parsed === null) return reply.code(400).send({ error: 'bad checkout request' });
    const entry = STORE_CATALOGUE.find((item) => item.sku === parsed.sku);
    if (!entry) return reply.code(404).send({ error: 'unknown sku' });

    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey === 'string' && confirmations.has(idempotencyKey)) {
      return confirmations.get(idempotencyKey);
    }

    orderSeq += 1;
    const totalPence = entry.price_pence * parsed.qty;
    const order = ShopifyOrdersPaid.parse({
      id: orderSeq,
      order_number: orderSeq,
      total_price: penceToPounds(totalPence),
      currency: 'GBP',
      processed_at: new Date().toISOString(),
      note_attributes: Object.entries(parsed.attributes).map(([name, value]) => ({
        name,
        value,
      })),
      line_items: [
        { sku: entry.sku, quantity: parsed.qty, price: penceToPounds(entry.price_pence) },
      ],
    });

    const rawBody = JSON.stringify(order);
    const webhookId =
      typeof idempotencyKey === 'string'
        ? createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
        : createHash('sha256').update(`${options.shopDomain}:${orderSeq}`).digest('hex').slice(0, 32);
    let webhook: 'delivered' | 'failed' = 'failed';
    try {
      const response = await fetch(options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SHOPIFY_HMAC_HEADER]: createHmac('sha256', options.webhookSecret)
            .update(rawBody, 'utf8')
            .digest('base64'),
          [SHOPIFY_SHOP_DOMAIN_HEADER]: options.shopDomain,
          [SHOPIFY_TOPIC_HEADER]: 'orders/paid',
          [SHOPIFY_WEBHOOK_ID_HEADER]: webhookId,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      webhook = response.status === 200 ? 'delivered' : 'failed';
    } catch {
      webhook = 'failed';
    }

    const confirmation = {
      order_number: orderSeq,
      total_pence: totalPence,
      webhook,
      // what the order echoed — lets tests assert the attribute round-trip
      note_attributes: order.note_attributes,
    };
    if (typeof idempotencyKey === 'string') confirmations.set(idempotencyKey, confirmation);
    return confirmation;
  });

  return app;
};

/** Re-export so store consumers can build the designated attribute map. */
export { SHOPIFY_TOKEN_ATTRIBUTE };
