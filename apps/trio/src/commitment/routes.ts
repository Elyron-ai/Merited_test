import { CommitmentDraft, CommitmentEndRequest, type CommitmentSigningService } from '@merited/contracts';
import type { FastifyInstance } from 'fastify';
import { TrioHttpError } from '../shared/deps.js';

/**
 * §7.1 routes. Imports ONLY the contracts interface (TRIO-13 seam rule) —
 * the simulator behind it is replaced file-for-file by PH1-24.
 */
export const registerCommitmentRoutes = (
  app: FastifyInstance,
  service: CommitmentSigningService,
): void => {
  const handle = (error: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (error instanceof TrioHttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    throw error;
  };

  app.post('/trio/commitments', async (req, reply) => {
    try {
      const draft = CommitmentDraft.parse(req.body);
      return await service.create(draft);
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.post('/trio/commitments/:id/end', async (req, reply) => {
    try {
      const request = CommitmentEndRequest.parse(req.body ?? {});
      return await service.end((req.params as { id: string }).id, request);
    } catch (error) {
      return handle(error, reply);
    }
  });

  app.get('/trio/commitments/:id', async (req, reply) => {
    try {
      return await service.status((req.params as { id: string }).id);
    } catch (error) {
      return handle(error, reply);
    }
  });
};
