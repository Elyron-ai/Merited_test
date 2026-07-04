import type { AgentCtx, RateLimiter } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { CoreHttpError } from '../../http-error.js';

declare module 'fastify' {
  interface FastifyRequest {
    agentCtx: AgentCtx;
  }
}

export interface AgentAuthOptions {
  authenticate(presentedKey: string): Promise<AgentCtx['agent_id']>;
  limiter: RateLimiter;
}

/**
 * Agent auth + per-agent rate limiting (CORE-3, B4/§5.2/§8).
 *
 * The B4-critical split: an ABSENT `X-Merited-Agent-Key` header is the
 * anonymous context (`agent_id: null` — degraded read, token: null +
 * register_to_earn downstream), NOT a 401. A PRESENT-but-invalid key is 401.
 * Limits key per-agent when authenticated, per-IP when anonymous; a denied
 * request is 429 with Retry-After.
 */
export const registerAgentAuth = (app: FastifyInstance, options: AgentAuthOptions): void => {
  app.decorateRequest('agentCtx');
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    const presented = req.headers['x-merited-agent-key'];
    let ctx: AgentCtx;
    if (typeof presented !== 'string' || presented.length === 0) {
      ctx = { agent_id: null };
    } else {
      const agentId = await options.authenticate(presented);
      if (agentId === null) throw new CoreHttpError(401, 'AGENT_AUTH_FAILED', 'invalid agent key');
      ctx = { agent_id: agentId };
    }
    const verdict = await options.limiter.allow(
      ctx.agent_id === null ? `ip:${req.ip}` : `agent:${ctx.agent_id}`,
    );
    if (!verdict.allowed) {
      void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
      throw new CoreHttpError(429, 'RATE_LIMITED', 'rate limit exceeded');
    }
    req.agentCtx = ctx;
  });
};
