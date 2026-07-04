import { ReverseRequest, type SettlementService } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { TrioHttpError } from '../shared/deps.js';

/**
 * §7.3 routes. Interface-only imports (the PH1-26 swap seam). TRIO-11 adds
 * `POST /trio/netting/run`, `GET /trio/positions/:party` and
 * `GET /trio/statements/:party/:period` here.
 */
export const registerSettlementRoutes = (
  app: FastifyInstance,
  service: SettlementService,
): void => {
  app.post('/trio/claims/reverse', async (req, reply) => {
    try {
      return await service.reverse(ReverseRequest.parse(req.body));
    } catch (error) {
      if (error instanceof TrioHttpError) {
        return reply.code(error.statusCode).send({ error: { code: error.code } });
      }
      throw error;
    }
  });
};
