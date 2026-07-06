import { registerTracing } from '@merited/otel';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerValidation } from './plugins/validation.js';

export type CoreServer = FastifyInstance;

/**
 * Core HTTP host (CORE-1, §1): Fastify + Zod type-provider, per-stage OTel
 * tracing (FND-14), structured error envelope. Module routes register on
 * top of this as their workstream tasks land (CORE-3 agents, CORE-12 REST
 * surface).
 */
export const createCoreServer = (): CoreServer => {
  // W7/#25: finite request + connection timeouts (Fastify defaults to 0 =
  // disabled) so a slow-body / stalled connection cannot hold a socket open
  // indefinitely (slowloris / R-U-Dead-Yet). Generous enough for any real
  // request; the bodyLimit (1 MiB default) bounds size separately.
  const app = Fastify({
    logger: false,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
  }).withTypeProvider<ZodTypeProvider>();
  registerTracing(app, 'merited-core');
  registerValidation(app);

  app.get('/healthz', async () => ({ ok: true, service: 'core' }));
  return app;
};
