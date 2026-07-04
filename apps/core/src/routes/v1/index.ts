import {
  QuoteStatusResponse,
  pence,
  type AgentCtx,
  type RateLimiter,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CoreHttpError } from '../../http-error.js';
import { registerAgentAuth } from '../../modules/agents/auth.js';
import { registerAgentRoutes } from '../../modules/agents/routes.js';
import type { AgentsService } from '../../modules/agents/service.js';
import type { ReadOffers } from '../../modules/offers/read-offers.js';
import type { QuoteService } from '../../modules/quotes/service.js';

const OffersQuery = z.object({
  merchant_id: z.string().optional(),
  sku: z.string().optional(),
  text: z.string().max(200).optional(),
  // consumer identity signals (§4 ConsumerCtx over the wire)
  consumer_ref: z.string().optional(),
  sub_hash: z.string().optional(),
  member_ref: z.string().optional(),
  hashed_email: z.string().optional(),
});

export interface V1Deps {
  readOffers: ReadOffers;
  quotes: QuoteService;
  agents: AgentsService;
  /** Per-agent (or per-IP) read-path limiter (§8). */
  readLimiter: RateLimiter;
  /** IP limiter for the open register route (CORE-3). */
  registerLimiter: RateLimiter;
}

/**
 * Every route is authenticated or EXPLICITLY anonymous-degraded (§8) —
 * the audit test asserts this classification covers the whole route table.
 */
export const ROUTE_CLASSIFICATIONS: Record<string, 'open-health' | 'open-rate-limited' | 'agent-degraded'> = {
  'GET /healthz': 'open-health',
  'POST /v1/agents/register': 'open-rate-limited',
  'GET /v1/offers': 'agent-degraded',
  'GET /v1/offers/:id': 'agent-degraded',
  'GET /v1/quotes/:id': 'agent-degraded',
};

/**
 * Phase-0 REST surface (CORE-12, B9/§4). Claims intake (`POST /v1/claims`,
 * `GET /v1/claims/:id`, the webhook) is OWNED by MER-3/4/5 inside
 * modules/adapters — not duplicated here (SYN-5). Ph1 routes (approve,
 * links) are reserved in documentation only — no handlers (§9 phase order).
 */
export const registerV1Routes = (app: FastifyInstance, deps: V1Deps): void => {
  registerAgentRoutes(app, deps.agents, { registerLimiter: deps.registerLimiter });

  // agent-auth-degraded scope: absent key = anonymous, invalid = 401, all rate-limited
  registerAgentAuth(app, {
    authenticate: (key) => deps.agents.authenticate(key),
    limiter: deps.readLimiter,
  });

  const consumerFrom = (query: z.infer<typeof OffersQuery>) => {
    const consumer = {
      ...(query.consumer_ref ? { consumer_ref: query.consumer_ref as `usr_${string}` } : {}),
      ...(query.sub_hash ? { sub_hash: query.sub_hash } : {}),
      ...(query.member_ref ? { member_ref: query.member_ref } : {}),
      ...(query.hashed_email ? { hashed_email: query.hashed_email } : {}),
    };
    return Object.keys(consumer).length > 0 ? consumer : undefined;
  };

  app.get('/v1/offers', { schema: { querystring: OffersQuery } }, async (req) => {
    const query = req.query as z.infer<typeof OffersQuery>;
    const agent: AgentCtx = req.agentCtx;
    const consumer = consumerFrom(query);
    return deps.readOffers.read({
      agent,
      ...(consumer ? { consumer } : {}),
      query: {
        ...(query.merchant_id ? { merchant_id: query.merchant_id } : {}),
        ...(query.sku ? { sku: query.sku } : {}),
        ...(query.text ? { text: query.text } : {}),
      },
    });
  });

  app.get('/v1/offers/:id', { schema: { querystring: OffersQuery } }, async (req) => {
    const query = req.query as z.infer<typeof OffersQuery>;
    const offerId = (req.params as { id: string }).id;
    const consumer = consumerFrom(query);
    // a full single-offer readOffers pass — fresh quote + token every call
    const response = await deps.readOffers.read({
      agent: req.agentCtx,
      ...(consumer ? { consumer } : {}),
      query: { offer_id: offerId },
    });
    if (response.quotes.length === 0) {
      throw new CoreHttpError(404, 'OFFER_NOT_AVAILABLE', 'offer unknown, not live, or not eligible');
    }
    return { quote: response.quotes[0], ...(response.hint ? { hint: response.hint } : {}) };
  });

  app.get('/v1/quotes/:id', async (req) => {
    const quoteId = (req.params as { id: string }).id;
    const [status, row] = await Promise.all([
      deps.quotes.getQuoteStatus(quoteId),
      deps.quotes.getQuote(quoteId),
    ]);
    return QuoteStatusResponse.parse({
      status,
      quote: {
        quote_id: row.quote_id,
        offer_id: row.offer_id,
        commitment_id: row.commitment_id,
        price: { list: pence(row.list_amount), final: pence(row.final_amount) },
        expires_at: row.expires_at,
      },
    });
  });
};
