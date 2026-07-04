import { createHash } from 'node:crypto';
import type pg from 'pg';
import { CoreHttpError } from '../../http-error.js';

export interface IdempotentResponse {
  status: number;
  /** Serialised response body — replays return these exact bytes. */
  body: string;
  replayed: boolean;
}

export const requestHashOf = (rawBody: string): string =>
  createHash('sha256').update(rawBody, 'utf8').digest('hex');

/**
 * §8/D7 idempotency over Postgres (MER-3): first delivery runs `work` and
 * stores the response; a replayed key returns the stored bytes verbatim
 * without re-executing; the same key with a DIFFERENT body is a 422
 * conflict. Concurrent duplicates converge via the primary key — the loser
 * of the insert race returns the winner's stored response.
 */
export const withIdempotency = async (
  pool: pg.Pool,
  input: { merchantId: string; key: string; requestHash: string },
  work: () => Promise<{ status: number; body: string }>,
): Promise<IdempotentResponse> => {
  const existing = await pool.query<{ request_hash: string; response_status: number; response_body: string }>(
    `SELECT request_hash, response_status, response_body
       FROM core.idempotency_keys WHERE merchant_id = $1 AND key = $2`,
    [input.merchantId, input.key],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_hash !== input.requestHash) {
      throw new CoreHttpError(422, 'IDEMPOTENCY_CONFLICT', 'same key, different body');
    }
    return {
      status: existing.rows[0].response_status,
      body: existing.rows[0].response_body,
      replayed: true,
    };
  }

  const result = await work();
  const inserted = await pool.query(
    `INSERT INTO core.idempotency_keys (merchant_id, key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (merchant_id, key) DO NOTHING
     RETURNING key`,
    [input.merchantId, input.key, input.requestHash, result.status, result.body],
  );
  if (inserted.rows.length === 0) {
    // lost a concurrent race — converge on the stored response
    const stored = await pool.query<{ request_hash: string; response_status: number; response_body: string }>(
      `SELECT request_hash, response_status, response_body
         FROM core.idempotency_keys WHERE merchant_id = $1 AND key = $2`,
      [input.merchantId, input.key],
    );
    const row = stored.rows[0]!;
    if (row.request_hash !== input.requestHash) {
      throw new CoreHttpError(422, 'IDEMPOTENCY_CONFLICT', 'same key, different body');
    }
    return { status: row.response_status, body: row.response_body, replayed: true };
  }
  return { status: result.status, body: result.body, replayed: false };
};
