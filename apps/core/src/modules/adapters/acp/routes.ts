import { AcpOrderWebhook } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { registerProtocolIntakeRoute, type ProtocolIntakeDeps } from '../protocol/intake.js';
import { AcpAdapter } from './adapter.js';

/**
 * ACP order-callback intake (PH3-4): the shared protocol posture
 * (`protocol/intake.ts`) with ACP's payload mapping — the token read ONLY
 * from `metadata["merited:token"]`.
 */
export type AcpRouteDeps = ProtocolIntakeDeps;

export const registerAcpOrderRoute = (app: FastifyInstance, deps: AcpRouteDeps): void => {
  const adapter = new AcpAdapter();
  registerProtocolIntakeRoute(app, deps, {
    path: '/v1/merchants/:merchant_slug/acp/order-completed',
    limiterKeyPrefix: 'acp',
    orderIn: (rawBody) => adapter.orderIn(AcpOrderWebhook.parse(JSON.parse(rawBody))),
    logMessage: 'acp callback rejected',
  });
};
