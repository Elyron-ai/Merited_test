import type { AgentCtx, RateLimiter } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { CoreHttpError } from '../../http-error.js';
import type { AgentRequestVerifier } from './request-signing.js';

declare module 'fastify' {
  interface FastifyRequest {
    agentCtx: AgentCtx;
  }
}

export interface AgentAuthOptions {
  authenticate(presentedKey: string): Promise<AgentCtx['agent_id']>;
  limiter: RateLimiter;
  /** PH1-5: Ed25519 signed-request tier — checked BEFORE the API-key
   * fallback when the signature headers are present. */
  requestVerifier?: AgentRequestVerifier;
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
    const signaturePresent = typeof req.headers['x-merited-signature'] === 'string';
    let ctx: AgentCtx;
    if (signaturePresent && options.requestVerifier) {
      // PH1-5 signed tier: presenting a signature commits you to it — a bad
      // signature is a 401, never a silent fall-through to weaker auth.
      const verdict = await options.requestVerifier.verify({
        method: req.method,
        pathWithQuery: req.url,
        rawBody: typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : '',
        headers: req.headers,
      });
      if (!verdict.ok) {
        throw new CoreHttpError(401, 'AGENT_AUTH_FAILED', `signature rejected: ${verdict.reason}`);
      }
      ctx = { agent_id: verdict.agentId };
    } else if (typeof presented !== 'string' || presented.length === 0) {
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
