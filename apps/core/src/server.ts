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
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  registerTracing(app, 'merited-core');
  registerValidation(app);

  app.get('/healthz', async () => ({ ok: true, service: 'core' }));
  return app;
};
