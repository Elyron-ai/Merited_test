import {
  FakeShopOrderWebhook,
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_MAX_SKEW_S,
  type Merchant,
  type RateLimiter,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CoreHttpError } from '../../../http-error.js';
import type { MerchantsService } from '../../merchants/service.js';
import { requestHashOf, withIdempotency } from '../idempotency.js';
import { precheckWebhook, verifyWebhookSignature } from './verify.js';

/** MER-4 plugs in here: normalise → build claim → sign → submit → verdict. */
export interface OrderProcessor {
  processOrder(
    payload: FakeShopOrderWebhook,
    merchant: Merchant,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface GradeBDeps {
  pool: pg.Pool;
  merchants: MerchantsService;
  limiter: RateLimiter;
  processor: OrderProcessor;
  clock?: { now(): Date };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

/**
 * Grade-B webhook intake (MER-3, §5.8): raw-body capture → uniform-401
 * authentication (merchant resolution + HMAC + skew — unknown slugs do not
 * enumerate) → per-merchant rate limit → Postgres idempotency → the MER-4
 * processor. Failed auth produces a structured log line and NO ledger event.
 */
export const registerGradeBWebhook = (app: FastifyInstance, deps: GradeBDeps): void => {
  void app.register(async (scope) => {
    // raw string body inside this scope only — HMAC verifies the exact bytes
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/v1/merchants/:merchant_slug/webhooks/order-confirmed', async (req, reply) => {
      const slug = (req.params as { merchant_slug: string }).merchant_slug;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const traceparent = typeof req.headers['traceparent'] === 'string' ? req.headers['traceparent'] : null;
      const deny = (reason: string) => {
        deps.logger?.warn({ merchant_slug: slug, reason, traceparent }, 'webhook delivery rejected');
        return reply.code(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED' } });
      };

      let merchant: Merchant;
      try {
        merchant = await deps.merchants.getBySlug(slug);
      } catch {
        return deny('merchant_unknown'); // uniform 401 — no slug enumeration
      }

      const nowS = Math.floor((deps.clock ?? { now: () => new Date() }).now().getTime() / 1000);
      const signatureHeader = req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined;
      const timestampHeader = req.headers[WEBHOOK_TIMESTAMP_HEADER] as string | undefined;
      // W4/#34: reject header-less / stale deliveries on the CHEAP secret-free
      // check before fetching + decrypting the merchant secrets (KMS in prod).
      const pre = precheckWebhook({ signatureHeader, timestampHeader, nowS, maxSkewS: WEBHOOK_TIMESTAMP_MAX_SKEW_S });
      if (!pre.ok) return deny(pre.reason);
      const secrets = await deps.merchants.activeWebhookSecrets(merchant.merchant_id);
      const verification = verifyWebhookSignature({
        rawBody,
        signatureHeader,
        timestampHeader,
        secrets,
        nowS,
        maxSkewS: WEBHOOK_TIMESTAMP_MAX_SKEW_S,
      });
      if (!verification.ok) return deny(verification.reason);

      const verdict = await deps.limiter.allow(`webhook:${merchant.merchant_id}`);
      if (!verdict.allowed) {
        void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
        return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
      }

      const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
      }

      let payload: FakeShopOrderWebhook;
      try {
        payload = FakeShopOrderWebhook.parse(JSON.parse(rawBody));
      } catch {
        return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await withIdempotency(
          deps.pool,
          { merchantId: merchant.merchant_id, key: idempotencyKey, requestHash: requestHashOf(rawBody) },
          async () => {
            const processed = await deps.processor.processOrder(payload, merchant);
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
