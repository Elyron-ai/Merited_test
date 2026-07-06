import { timingSafeEqual } from 'node:crypto';
import { registerTracing } from '@merited/otel';
import type { Signer } from '@merited/signing';
import Fastify, { type FastifyInstance } from 'fastify';
import { systemClock, type Clock } from './clock.js';
import { verifyServiceToken } from './service-token.js';

export interface TrioServerOptions {
  /** Core→trio shared-secret service token (SYN-24; static path). */
  serviceToken: string;
  /** PH1-25: when set, `svt.v1.…` SIGNED service tokens are also accepted
   * (arch §6 hardening). Static stays accepted alongside — deployments
   * flip to signed-only by dropping the static secret at config time. */
  signer?: Signer;
  clock?: Clock;
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
  // W7/#25: finite request + connection timeouts (Fastify defaults are 0 =
  // disabled) so a stalled connection cannot hold a socket open indefinitely.
  const app = Fastify({ requestTimeout: 30_000, connectionTimeout: 30_000 });
  registerTracing(app, 'merited-trio');

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const presented = req.headers['x-merited-service-token'];
    const actual = Buffer.from(typeof presented === 'string' ? presented : '');
    const expected = Buffer.from(options.serviceToken);
    let ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!ok && options.signer && typeof presented === 'string' && presented.startsWith('svt.v1.')) {
      ok = await verifyServiceToken(options.signer, options.clock ?? systemClock, presented);
    }
    if (!ok) {
      await reply.code(401).send({ error: { code: 'SERVICE_AUTH_FAILED' } });
    }
  });

  app.get('/healthz', async () => ({ ok: true, service: 'trio' }));
  return app;
};
