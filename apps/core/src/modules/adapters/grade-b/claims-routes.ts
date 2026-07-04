import {
  ConversionClaim,
  IDEMPOTENCY_KEY_HEADER,
  type Merchant,
  type MeritedId,
  type RateLimiter,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CoreHttpError } from '../../../http-error.js';
import type { AgentsService } from '../../agents/service.js';
import type { MerchantsService } from '../../merchants/service.js';
import { requestHashOf, withIdempotency } from '../idempotency.js';

export interface ClaimSubmitter {
  submitFormedClaim(
    claim: ConversionClaim,
    merchant: Merchant,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface ClaimsApiDeps {
  pool: pg.Pool;
  merchants: MerchantsService;
  agents: AgentsService;
  submitter: ClaimSubmitter;
  limiter: RateLimiter;
}

const MERCHANT_KEY_HEADER = 'x-merited-merchant-key';
const AGENT_KEY_HEADER = 'x-merited-agent-key';

/**
 * Claims API surface (MER-5, §4): `POST /v1/claims` — Grade-B intake for a
 * FORMED `ConversionClaim`, merchant-key authenticated, same idempotency
 * semantics as the webhook, forwarding through the SAME MER-4 funnel (P2
 * applied to the write side). `GET /v1/claims/:id` — readable by the
 * claiming merchant and the token's agent (ownership via the quote's qid).
 */
export const registerClaimsRoutes = (app: FastifyInstance, deps: ClaimsApiDeps): void => {
  app.post('/v1/claims', async (req, reply) => {
    const presented = req.headers[MERCHANT_KEY_HEADER];
    const merchantId =
      typeof presented === 'string' && presented.length > 0
        ? await deps.merchants.authenticate(presented)
        : null;
    if (!merchantId) {
      return reply.code(401).send({ error: { code: 'MERCHANT_AUTH_FAILED' } });
    }
    const verdict = await deps.limiter.allow(`claims:${merchantId}`);
    if (!verdict.allowed) {
      void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
    }
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
    }
    const parsed = ConversionClaim.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
    }
    if (parsed.data.merchant_id !== merchantId) {
      return reply.code(403).send({ error: { code: 'CLAIM_MERCHANT_MISMATCH' } });
    }
    const merchant = await deps.merchants.get(merchantId);
    try {
      const result = await withIdempotency(
        deps.pool,
        { merchantId, key: idempotencyKey, requestHash: requestHashOf(canonicalJson(parsed.data)) },
        async () => {
          const submitted = await deps.submitter.submitFormedClaim(parsed.data, merchant);
          return { status: submitted.status, body: JSON.stringify(submitted.body) };
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

  app.get('/v1/claims/:id', async (req, reply) => {
    const claimId = (req.params as { id: string }).id;
    const { rows } = await deps.pool.query<{
      claim_id: string;
      merchant_id: MeritedId<'mer'>;
      qid: string | null;
      verdict: 'pending' | 'verified' | 'rejected';
      reason_code: string | null;
    }>(
      `SELECT claim_id, merchant_id, qid, verdict, reason_code
         FROM core.claims_intake WHERE claim_id = $1`,
      [claimId],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: { code: 'CLAIM_NOT_FOUND' } });

    // ownership: the claiming merchant, or the agent the token's quote was issued to
    let authorised = false;
    const merchantKey = req.headers[MERCHANT_KEY_HEADER];
    if (typeof merchantKey === 'string' && merchantKey.length > 0) {
      authorised = (await deps.merchants.authenticate(merchantKey)) === row.merchant_id;
    }
    const agentKey = req.headers[AGENT_KEY_HEADER];
    if (!authorised && typeof agentKey === 'string' && agentKey.length > 0 && row.qid) {
      const agentId = await deps.agents.authenticate(agentKey);
      if (agentId) {
        const quote = await deps.pool.query<{ agent_id: string | null }>(
          `SELECT agent_id FROM core.quotes WHERE quote_id = $1`,
          [row.qid],
        );
        authorised = quote.rows[0]?.agent_id === agentId;
      }
    }
    if (!authorised) return reply.code(401).send({ error: { code: 'CLAIM_ACCESS_DENIED' } });

    return {
      claim_id: row.claim_id,
      status: row.verdict,
      ...(row.verdict !== 'pending' ? { verdict: row.verdict } : {}),
      ...(row.reason_code ? { reason_code: row.reason_code } : {}),
    };
  });
};
