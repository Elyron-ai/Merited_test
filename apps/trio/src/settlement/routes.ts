import { NettingRunRequest, ReverseRequest, type SettlementService } from '@merited/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendTrioError } from '../shared/deps.js';
import { renderStatementPdf } from './statements.js';

/**
 * §7.3 routes. Service access is interface-only (the PH1-26 swap seam);
 * `statements.js` is a RETAINED module (TRIO-16), so the PDF rendering path
 * lives outside the swap and is imported here directly.
 */
export const registerSettlementRoutes = (
  app: FastifyInstance,
  service: SettlementService,
  options: { chromiumPath?: string } = {},
): void => {
  const handle = (error: unknown, reply: FastifyReply): unknown => sendTrioError(error, reply);

  app.post('/trio/claims/reverse', async (req, reply) => {
    try {
      return await service.reverse(ReverseRequest.parse(req.body));
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.post('/trio/netting/run', async (req, reply) => {
    try {
      return await service.runNetting(NettingRunRequest.parse(req.body));
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.get('/trio/positions/:party', async (req, reply) => {
    try {
      return await service.position((req.params as { party: string }).party);
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.get('/trio/statements/:party/:period', async (req, reply) => {
    try {
      const { party, period } = req.params as { party: string; period: string };
      return await service.statement(party, period);
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.get('/trio/statements/:party/:period/pdf', async (req, reply) => {
    try {
      const { party, period } = req.params as { party: string; period: string };
      const statement = await service.statement(party, period);
      const pdf = await renderStatementPdf(
        statement,
        options.chromiumPath ? { executablePath: options.chromiumPath } : {},
      );
      return await reply.type('application/pdf').send(pdf);
    } catch (error) {
      return handle(error, reply);
    }
  });
};
