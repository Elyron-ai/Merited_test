import { UcpCheckoutCompleted } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { registerProtocolIntakeRoute, type ProtocolIntakeDeps } from '../protocol/intake.js';
import { UcpAdapter } from './adapter.js';

/**
 * UCP checkout-callback intake (PH3-3): the shared protocol posture
 * (`protocol/intake.ts`) with UCP's payload mapping — the token read ONLY
 * from the `com.merited.attribution` extension envelope.
 */
export type UcpRouteDeps = ProtocolIntakeDeps;

export const registerUcpCheckoutRoute = (app: FastifyInstance, deps: UcpRouteDeps): void => {
  const adapter = new UcpAdapter();
  registerProtocolIntakeRoute(app, deps, {
    path: '/v1/merchants/:merchant_slug/ucp/checkout-completed',
    limiterKeyPrefix: 'ucp',
    orderIn: (rawBody) => adapter.orderIn(UcpCheckoutCompleted.parse(JSON.parse(rawBody))),
    logMessage: 'ucp callback rejected',
  });
};
