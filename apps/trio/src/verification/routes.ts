import {
  MintRequest,
  VerifyRequest,
  type ConversionVerificationService,
  type TokenMintService,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import type { FastifyInstance } from 'fastify';
import { sendTrioError } from '../shared/deps.js';

/** §7.2 routes. Interface-only imports (the PH1-25 swap seam). */
export const registerVerifyRoutes = (
  app: FastifyInstance,
  service: ConversionVerificationService,
): void => {
  app.post('/trio/claims/verify', async (req, reply) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      const verdict = await service.verify(VerifyRequest.parse(req.body), {
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : '',
      });
      // Canonical serialisation on the wire, so an idempotent replay of the
      // stored verdict is byte-identical to the original response (§8/D7) —
      // found by the TRIO-13 gap sweep.
      return await reply.type('application/json; charset=utf-8').send(canonicalJson(verdict));
    } catch (error) {
      return sendTrioError(error, reply);
    }
  });
};

export const registerMintRoutes = (app: FastifyInstance, service: TokenMintService): void => {
  app.post('/trio/tokens/mint', async (req, reply) => {
    try {
      return await service.mint(MintRequest.parse(req.body));
    } catch (error) {
      return sendTrioError(error, reply);
    }
  });
};
