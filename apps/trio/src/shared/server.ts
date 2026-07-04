import { timingSafeEqual } from 'node:crypto';
import { registerTracing } from '@merited/otel';
import Fastify, { type FastifyInstance } from 'fastify';

export interface TrioServerOptions {
  /** Core→trio shared-secret service token (SYN-24; mTLS/signed tokens: PH1-25). */
  serviceToken: string;
}

/**
 * Trio HTTP host (TRIO-3): one Fastify app hosting all three services as a
 * single Phase-0 deploy unit. Every route except /healthz requires the
 * X-Merited-Service-Token header (P3: the trio never trusts the monolith
 * blindly — full signature verification on payloads arrives with each
 * service's pipeline; this gate is transport-level).
 */
export const createTrioServer = (options: TrioServerOptions): FastifyInstance => {
  if (!options.serviceToken) throw new Error('trio requires MERITED_TRIO_SERVICE_TOKEN');
  const app = Fastify();
  registerTracing(app, 'merited-trio');

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const presented = req.headers['x-merited-service-token'];
    const expected = Buffer.from(options.serviceToken);
    const actual = Buffer.from(typeof presented === 'string' ? presented : '');
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!ok) {
      await reply.code(401).send({ error: { code: 'SERVICE_AUTH_FAILED' } });
    }
  });

  app.get('/healthz', async () => ({ ok: true, service: 'trio' }));
  return app;
};
