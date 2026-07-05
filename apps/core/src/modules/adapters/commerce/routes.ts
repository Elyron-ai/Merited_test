import {
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_WEBHOOK_ID_HEADER,
  ShopifyOrdersPaid,
  type Merchant,
  type OrderConfirmed,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { CoreHttpError } from '../../../http-error.js';
import { requestHashOf, withIdempotency } from '../idempotency.js';
import type { ProtocolIntakeDeps } from '../protocol/intake.js';
import { ShopifyCommerceAdapter } from './shopify.js';
import { verifyShopifyHmac } from './verify-shopify.js';

/**
 * Shopify `orders/paid` intake (PH3-5): the SAME posture as every other
 * inbound delivery — authenticate over the raw bytes FIRST (Shopify's
 * native base64 HMAC, on in every environment, §8), uniform 401, rate
 * limit, mandatory idempotency (Shopify's own `x-shopify-webhook-id`),
 * then the CommerceAdapter normalisation into the ONE claim funnel
 * (`processConfirmedOrder`). An order without the `merited_token` note
 * attribute is acknowledged and DROPPED: no claim, no ledger event (P2).
 */
export type ShopifyRouteDeps = ProtocolIntakeDeps;

export const registerShopifyOrdersPaidRoute = (
  app: FastifyInstance,
  deps: ShopifyRouteDeps,
): void => {
  const adapter = new ShopifyCommerceAdapter();
  void app.register(async (scope) => {
    // raw string body inside this scope only — HMAC verifies the exact bytes
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/v1/merchants/:merchant_slug/shopify/orders-paid', async (req, reply) => {
      const slug = (req.params as { merchant_slug: string }).merchant_slug;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const deny = (reason: string) => {
        deps.logger?.warn({ merchant_slug: slug, reason }, 'shopify delivery rejected');
        return reply.code(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED' } });
      };

      let merchant: Merchant;
      try {
        merchant = await deps.merchants.getBySlug(slug);
      } catch {
        return deny('merchant_unknown'); // uniform 401 — no slug enumeration
      }

      const secrets = await deps.merchants.activeWebhookSecrets(merchant.merchant_id);
      const verification = verifyShopifyHmac({
        rawBody,
        hmacHeader: req.headers[SHOPIFY_HMAC_HEADER] as string | undefined,
        secrets,
      });
      if (!verification.ok) return deny(verification.reason);

      const verdict = await deps.limiter.allow(`shopify:${merchant.merchant_id}`);
      if (!verdict.allowed) {
        void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
        return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
      }

      const webhookId = req.headers[SHOPIFY_WEBHOOK_ID_HEADER];
      if (typeof webhookId !== 'string' || webhookId.length === 0) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
      }
      const shopDomain = req.headers[SHOPIFY_SHOP_DOMAIN_HEADER];
      if (typeof shopDomain !== 'string' || shopDomain.length === 0) {
        return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      let order: OrderConfirmed;
      try {
        order = adapter.normaliseOrderEvent({
          shop_domain: shopDomain,
          order: ShopifyOrdersPaid.parse(JSON.parse(rawBody)),
        });
      } catch {
        return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await withIdempotency(
          deps.pool,
          {
            merchantId: merchant.merchant_id,
            key: `shopify:${webhookId}`,
            requestHash: requestHashOf(rawBody),
          },
          async () => {
            const processed = await deps.processor.processConfirmedOrder(order, merchant);
            return { status: processed.status, body: JSON.stringify(processed.body) };
          },
        );
        return await reply
          .code(result.status)
          .type('application/json; charset=utf-8')
          .send(result.body);
      } catch (error) {
        if (error instanceof CoreHttpError) {
          return reply.code(error.statusCode).send({ error: { code: error.code } });
        }
        throw error;
      }
    });
  });
};
