import type pg from 'pg';
import { canonicalJson } from './canonical-json.js';
import { chainHash, GENESIS_PREV_HASH } from './hash.js';

export type ChainVerification =
  | { ok: true; count: number; head: string | null }
  | { ok: false; broken_seq: number; problem: string };

/**
 * Walk the chain seq-ascending, recomputing every hash and checking linkage
 * (B2; the FND-13 CLI wraps this). Detects any post-hoc mutation of body,
 * type, or hashes — including by roles that bypass the REVOKE.
 */
export const verifyChain = async (client: pg.ClientBase): Promise<ChainVerification> => {
  const batchSize = 500;
  let prev = GENESIS_PREV_HASH;
  let count = 0;
  let head: string | null = null;
  let lastSeq = 0;

  for (;;) {
    const { rows } = await client.query<{
      seq: string;
      type: string;
      body: unknown;
      prev_hash: string;
      this_hash: string;
    }>(
      'SELECT seq, type, body, prev_hash, this_hash FROM events.events WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
      [lastSeq, batchSize],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq !== lastSeq + 1) {
        return { ok: false, broken_seq: seq, problem: `gap: expected seq ${lastSeq + 1}` };
      }
      if (row.prev_hash !== prev) {
        return { ok: false, broken_seq: seq, problem: 'prev_hash does not link to prior event' };
      }
      const body = row.body as { type?: unknown };
      if (body?.type !== row.type) {
        return { ok: false, broken_seq: seq, problem: 'type column does not match body.type' };
      }
      const recomputed = chainHash(prev, canonicalJson(row.body));
      if (recomputed !== row.this_hash) {
        return { ok: false, broken_seq: seq, problem: 'this_hash does not match recomputed hash' };
      }
      prev = row.this_hash;
      head = row.this_hash;
      lastSeq = seq;
      count += 1;
    }
  }
  return { ok: true, count, head };
};
