import {
  MintRequest,
  VerifyRequest,
  type ConversionVerificationService,
  type TokenMintService,
} from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { TrioHttpError } from '../shared/deps.js';

/** §7.2 routes. Interface-only imports (the PH1-25 swap seam). */
export const registerVerifyRoutes = (
  app: FastifyInstance,
  service: ConversionVerificationService,
): void => {
  app.post('/trio/claims/verify', async (req, reply) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      return await service.verify(VerifyRequest.parse(req.body), {
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : '',
      });
    } catch (error) {
      if (error instanceof TrioHttpError) {
        return reply.code(error.statusCode).send({ error: { code: error.code } });
      }
      throw error;
    }
  });
};

export const registerMintRoutes = (app: FastifyInstance, service: TokenMintService): void => {
  app.post('/trio/tokens/mint', async (req, reply) => {
    try {
      return await service.mint(MintRequest.parse(req.body));
    } catch (error) {
      if (error instanceof TrioHttpError) {
        return reply.code(error.statusCode).send({ error: { code: error.code } });
      }
      throw error;
    }
  });
};
