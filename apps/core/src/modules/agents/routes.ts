import { AgentRegisterRequest, type RateLimiter } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { CoreHttpError } from '../../http-error.js';
import type { AgentsService } from './service.js';

/**
 * `POST /v1/agents/register` (CORE-3): open route, IP-rate-limited. The
 * api_key in the response is the ONLY time the clear key exists outside the
 * caller — it is never stored or logged.
 */
export const registerAgentRoutes = (
  app: FastifyInstance,
  service: AgentsService,
  options: { registerLimiter: RateLimiter },
): void => {
  app.post('/v1/agents/register', { schema: { body: AgentRegisterRequest } }, async (req, reply) => {
    const verdict = await options.registerLimiter.allow(`register:${req.ip}`);
    if (!verdict.allowed) {
      void reply.header('retry-after', String(verdict.retryAfterS ?? 1));
      throw new CoreHttpError(429, 'RATE_LIMITED', 'rate limit exceeded');
    }
    const body = req.body as AgentRegisterRequest;
    return service.register({
      name: body.name,
      contact: body.contact,
      ...(body.public_key ? { public_key: body.public_key } : {}),
    });
  });
};
