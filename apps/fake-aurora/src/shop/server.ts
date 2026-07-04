import { FakeShopOrderWebhook } from '@merited/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOGUE, skuByRef } from './catalogue.js';
import { deliverOrderWebhook } from './webhook-sender.js';

const CheckoutBody = z.object({
  sku: z.string().min(1),
  attribution_token: z.string().nullable().default(null),
  qty: z.number().int().positive().default(1),
});

export interface FakeShopOptions {
  shopDomain: string;
  adapterUrl: string;
  webhookSecret: string;
  /** FAKESHOP_DROP_WEBHOOK_PCT — Phase-1 under-reporting rehearsal. */
  dropWebhookPct?: number;
  /** Injected randomness for the drop flag (deterministic tests). */
  random?: () => number;
}

/**
 * FakeShop (MER-11, §5.8): the standing Aurora Experiences storefront —
 * dumb and merchant-shaped. It knows ONLY the webhook wire contract from
 * `@merited/contracts` (P5: zero imports from core or the trio). Token-less
 * checkouts complete and emit like any other order — the ADAPTER decides
 * claim-worthiness, not the shop.
 */
export const createFakeShop = (options: FakeShopOptions): FastifyInstance => {
  const app = Fastify();
  let orderSeq = 1000;
  // Checkout idempotency (§8, consumed by VAL-5/8): a repeated Idempotency-Key
  // replays the SAME confirmation — one order, one webhook — so an agent
  // resuming a crashed errand never double-buys. In-memory is honest for a
  // fake shop; a real merchant holds this in its order store.
  const confirmations = new Map<string, unknown>();

  app.get('/skus', async () => ({ skus: CATALOGUE }));

  app.post('/checkout', async (req, reply) => {
    const parsed = CheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad checkout request' });
    }
    const entry = skuByRef(parsed.data.sku);
    if (!entry) return reply.code(404).send({ error: 'unknown sku' });

    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey === 'string' && confirmations.has(idempotencyKey)) {
      return confirmations.get(idempotencyKey);
    }

    orderSeq += 1;
    const order = FakeShopOrderWebhook.parse({
      event: 'order.confirmed',
      shop_domain: options.shopDomain,
      order: {
        number: orderSeq,
        placed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        total: {
          amount_minor: entry.price_pence * parsed.data.qty,
          currency_code: 'GBP',
        },
        attribution: { merited_token: parsed.data.attribution_token },
        lines: [
          { sku: entry.sku, qty: parsed.data.qty, unit_price_minor: entry.price_pence },
        ],
      },
    });

    const dropPct = options.dropWebhookPct ?? 0;
    const dropped = dropPct > 0 && (options.random ?? Math.random)() * 100 < dropPct;
    let delivery = { delivered: false, attempts: 0 };
    if (!dropped) {
      delivery = await deliverOrderWebhook(order, {
        adapterUrl: options.adapterUrl,
        secret: options.webhookSecret,
        idempotencyKey: String(order.order.number),
      });
    }

    const confirmation = {
      order_number: order.order.number,
      status: 'confirmed',
      total_pence: order.order.total.amount_minor,
      webhook: dropped ? 'dropped' : delivery.delivered ? 'delivered' : 'failed',
    };
    if (typeof idempotencyKey === 'string') confirmations.set(idempotencyKey, confirmation);
    return confirmation;
  });

  return app;
};
