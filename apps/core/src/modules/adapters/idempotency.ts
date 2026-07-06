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

/** How long a concurrent duplicate waits for the in-flight winner before giving
 * up with a retryable 409, and how often it re-checks. work() includes a trio
 * HTTP round-trip, so the ceiling is generous; the poll only runs for the rare
 * genuinely-concurrent duplicate. */
const IN_PROGRESS_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface KeyRow {
  request_hash: string;
  response_status: number | null;
  response_body: string | null;
}

/**
 * §8/D7 idempotency over Postgres (MER-3), RESERVE-BEFORE-WORK (W10/#26): the
 * key is reserved (a pending row, NULL response) BEFORE `work` runs, so only
 * the winner of the insert race executes the side-effecting funnel — concurrent
 * duplicates no longer each write a ConversionClaimed event + claims_intake row.
 * The winner fills the reservation in with its response; a concurrent loser
 * waits for and returns those exact stored bytes. A replayed key returns the
 * stored bytes without re-executing; the same key with a DIFFERENT body is a
 * 422 conflict. If the winner's work() throws, its pending reservation is
 * released so a retry can proceed (matching the pre-reservation behaviour where
 * a failed delivery left no key).
 */
export const withIdempotency = async (
  pool: pg.Pool,
  input: { merchantId: string; key: string; requestHash: string },
  work: () => Promise<{ status: number; body: string }>,
): Promise<IdempotentResponse> => {
  const readKey = async (): Promise<KeyRow | undefined> => {
    const { rows } = await pool.query<KeyRow>(
      `SELECT request_hash, response_status, response_body
         FROM core.idempotency_keys WHERE merchant_id = $1 AND key = $2`,
      [input.merchantId, input.key],
    );
    return rows[0];
  };

  const conflictIfMismatch = (row: KeyRow): void => {
    if (row.request_hash !== input.requestHash) {
      throw new CoreHttpError(422, 'IDEMPOTENCY_CONFLICT', 'same key, different body');
    }
  };

  const deadline = Date.now() + IN_PROGRESS_TIMEOUT_MS;
  for (;;) {
    // 1) try to RESERVE the key before doing any work
    const reserved = await pool.query(
      `INSERT INTO core.idempotency_keys (merchant_id, key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id, key) DO NOTHING
       RETURNING key`,
      [input.merchantId, input.key, input.requestHash],
    );

    if (reserved.rows.length === 1) {
      // we own the reservation — run work() exactly once, then store the result
      let result: { status: number; body: string };
      try {
        result = await work();
      } catch (error) {
        // release the pending reservation so a retry (or a waiting duplicate)
        // can take over; only ever deletes a row we left pending
        await pool.query(
          `DELETE FROM core.idempotency_keys
             WHERE merchant_id = $1 AND key = $2 AND response_status IS NULL`,
          [input.merchantId, input.key],
        );
        throw error;
      }
      await pool.query(
        `UPDATE core.idempotency_keys
            SET response_status = $3, response_body = $4
          WHERE merchant_id = $1 AND key = $2`,
        [input.merchantId, input.key, result.status, result.body],
      );
      return { status: result.status, body: result.body, replayed: false };
    }

    // 2) someone else holds the key — read it
    const row = await readKey();
    if (!row) continue; // reservation vanished (a failed winner released it) → retry
    conflictIfMismatch(row);
    if (row.response_status !== null && row.response_body !== null) {
      // winner finished — converge on its stored response
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    // 3) still pending — wait briefly for the winner, then retry the read
    if (Date.now() >= deadline) {
      throw new CoreHttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'duplicate in progress, retry');
    }
    await sleep(POLL_INTERVAL_MS);
  }
};
