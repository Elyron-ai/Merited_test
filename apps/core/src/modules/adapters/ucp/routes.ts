import {
  UcpCheckoutCompleted,
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
import type { GradeBOrderProcessor } from '../grade-b/processor.js';
import { requestHashOf, withIdempotency } from '../idempotency.js';
import { verifyWebhookSignature } from '../grade-b/verify.js';
import { UcpAdapter } from './adapter.js';

/**
 * UCP checkout-callback intake (PH3-3): the SAME security posture as the
 * Grade-B webhook — merchant-scoped HMAC over the raw bytes (on in every
 * environment, §8), timestamp skew bound, per-merchant rate limit,
 * mandatory Idempotency-Key — then `UcpAdapter.orderIn` (designated-field
 * token only) into the ONE claim funnel (`processConfirmedOrder`). A
 * callback without the token in the designated extension is acknowledged
 * and DROPPED: no claim, no ledger event (P2 — no token, no bounty).
 */
export interface UcpRouteDeps {
  pool: pg.Pool;
  merchants: MerchantsService;
  limiter: RateLimiter;
  processor: GradeBOrderProcessor;
  clock?: { now(): Date };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

export const registerUcpCheckoutRoute = (app: FastifyInstance, deps: UcpRouteDeps): void => {
  const adapter = new UcpAdapter();
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/v1/merchants/:merchant_slug/ucp/checkout-completed', async (req, reply) => {
      const slug = (req.params as { merchant_slug: string }).merchant_slug;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const deny = (reason: string) => {
        deps.logger?.warn({ merchant_slug: slug, reason }, 'ucp callback rejected');
        return reply.code(401).send({ error: { code: 'WEBHOOK_AUTH_FAILED' } });
      };

      let merchant: Merchant;
      try {
        merchant = await deps.merchants.getBySlug(slug);
      } catch {
        return deny('merchant_unknown');
      }

      const secrets = await deps.merchants.activeWebhookSecrets(merchant.merchant_id);
      const verification = verifyWebhookSignature({
        rawBody,
        signatureHeader: req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined,
        timestampHeader: req.headers[WEBHOOK_TIMESTAMP_HEADER] as string | undefined,
        secrets,
        nowS: Math.floor((deps.clock ?? { now: () => new Date() }).now().getTime() / 1000),
        maxSkewS: WEBHOOK_TIMESTAMP_MAX_SKEW_S,
      });
      if (!verification.ok) return deny(verification.reason);

      const verdict = await deps.limiter.allow(`ucp:${merchant.merchant_id}`);
      if (!verdict.allowed) {
        void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
        return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
      }

      const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
      }

      let callback: UcpCheckoutCompleted;
      try {
        callback = UcpCheckoutCompleted.parse(JSON.parse(rawBody));
      } catch {
        return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await withIdempotency(
          deps.pool,
          { merchantId: merchant.merchant_id, key: idempotencyKey, requestHash: requestHashOf(rawBody) },
          async () => {
            const processed = await deps.processor.processConfirmedOrder(
              adapter.orderIn(callback),
              merchant,
            );
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
