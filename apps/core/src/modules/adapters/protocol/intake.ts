import {
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_MAX_SKEW_S,
  type Merchant,
  type OrderConfirmed,
  type RateLimiter,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CoreHttpError } from '../../../http-error.js';
import type { MerchantsService } from '../../merchants/service.js';
import type { GradeBOrderProcessor } from '../grade-b/processor.js';
import { precheckWebhook, verifyWebhookSignature } from '../grade-b/verify.js';
import { requestHashOf, withIdempotency } from '../idempotency.js';

/**
 * The shared protocol callback intake (PH3-3/PH3-4): every protocol's
 * checkout/order callback enters through THIS posture — the same one the
 * Grade-B webhook proved. Merchant-scoped HMAC over the raw bytes (on in
 * every environment, §8), timestamp skew bound, uniform 401 (no slug
 * enumeration), per-merchant rate limit, mandatory Idempotency-Key with
 * byte-identical replay — then the protocol adapter's `orderIn` into the
 * ONE claim funnel (`processConfirmedOrder`). A callback without the token
 * in its designated field is acknowledged and DROPPED: no claim, no ledger
 * event (P2 — no token, no bounty). Protocols differ ONLY in path, limiter
 * namespace and payload mapping — never in security posture or write path.
 */
export interface ProtocolIntakeDeps {
  pool: pg.Pool;
  merchants: MerchantsService;
  limiter: RateLimiter;
  processor: GradeBOrderProcessor;
  clock?: { now(): Date };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
}

export interface ProtocolIntakeSpec {
  /** Fastify route path carrying `:merchant_slug`. */
  path: string;
  /** Per-merchant limiter namespace, e.g. `ucp` → key `ucp:{merchant_id}`. */
  limiterKeyPrefix: string;
  /** Raw JSON body → `OrderConfirmed` (schema parse + adapter mapping);
   * throws on shape failure → 400 VALIDATION_FAILED. */
  orderIn(rawBody: string): OrderConfirmed;
  /** Structured-log message on auth rejection. */
  logMessage: string;
}

export const registerProtocolIntakeRoute = (
  app: FastifyInstance,
  deps: ProtocolIntakeDeps,
  spec: ProtocolIntakeSpec,
): void => {
  void app.register(async (scope) => {
    // raw string body inside this scope only — HMAC verifies the exact bytes
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(spec.path, async (req, reply) => {
      const slug = (req.params as { merchant_slug: string }).merchant_slug;
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const deny = (reason: string) => {
        deps.logger?.warn({ merchant_slug: slug, reason }, spec.logMessage);
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
      // W4/#34: cheap secret-free precheck before the secret decrypt.
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

      const verdict = await deps.limiter.allow(`${spec.limiterKeyPrefix}:${merchant.merchant_id}`);
      if (!verdict.allowed) {
        void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
        return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
      }

      const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
      }

      let order: OrderConfirmed;
      try {
        order = spec.orderIn(rawBody);
      } catch {
        return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await withIdempotency(
          deps.pool,
          { merchantId: merchant.merchant_id, key: idempotencyKey, requestHash: requestHashOf(rawBody) },
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
