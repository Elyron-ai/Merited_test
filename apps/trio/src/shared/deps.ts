import type { Signer } from '@merited/signing';
import type pg from 'pg';
import { ZodError } from 'zod';
import type { Clock } from './clock.js';

/** Constructor-injected dependencies for every trio service (SYN-30: time and
 * keys arrive here, never from ambient environment inside the services). */
export interface TrioDeps {
  pool: pg.Pool;
  signer: Signer;
  clock: Clock;
}

export const PLATFORM_COMMITMENT_KEY = 'platform/commitments';
export const PLATFORM_MINT_KEY = 'platform/mint';
export const merchantKeyRef = (merchantId: string): string => `merchant/${merchantId}`;

/** Run work inside one transaction (ledger events commit with the write). */
export const inTx = async <T>(pool: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export class TrioHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'TrioHttpError';
  }
}

/**
 * Shared route error mapping (retained; used by every routes.ts): service
 * errors carry their own status; malformed public input (Zod) is the
 * caller's fault — 400, never a 500 (found by the TRIO-13 gap sweep).
 */
export const sendTrioError = (
  error: unknown,
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
): unknown => {
  if (error instanceof TrioHttpError) {
    return reply.code(error.statusCode).send({ error: { code: error.code } });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
  }
  throw error;
};
