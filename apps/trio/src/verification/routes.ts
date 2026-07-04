import { MintRequest, type TokenMintService } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { TrioHttpError } from '../shared/deps.js';

/** §7.2 mint route (verify route lands with TRIO-8). Interface-only imports. */
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
