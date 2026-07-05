import { HeadPublication } from '@merited/contracts';
import type pg from 'pg';
import type { ObjectStore } from './object-store.js';

/**
 * Ledger head publication (PH1-21, architecture §2.6: "simplest credible
 * option — a public S3 object"; blockchain anchoring is unnecessary theatre).
 * One dumb, stable JSON object per UTC day: `{date, seq, head_hash}` under
 * `heads/<date>.json`, plus a `heads/latest.json` convenience pointer. The
 * format is part of the future open spec (PH3-7/8) — nothing else goes in.
 *
 * Idempotent per day, FIRST-WRITE-WINS: once a day's head is published it is
 * never rewritten — an anchor that can be replaced anchors nothing. A re-run
 * on the same day (even after more events) is a recorded no-op.
 */
export const HEADS_PREFIX = 'heads/';
export const headKey = (date: string): string => `${HEADS_PREFIX}${date}.json`;

/** The chain head right now: highest seq + its hash (null on an empty ledger). */
export const currentHead = async (
  client: pg.ClientBase,
): Promise<{ seq: number; head_hash: string } | null> => {
  const { rows } = await client.query<{ seq: string; this_hash: string }>(
    'SELECT seq, this_hash FROM events.events ORDER BY seq DESC LIMIT 1',
  );
  return rows[0] ? { seq: Number(rows[0].seq), head_hash: rows[0].this_hash } : null;
};

export type PublishOutcome =
  | { published: true; publication: HeadPublication }
  | { published: false; reason: 'already_published'; publication: HeadPublication }
  | { published: false; reason: 'empty_ledger' };

export const publishHead = async (
  pool: pg.Pool,
  store: ObjectStore,
  options: { date?: string; clock?: { now(): Date } } = {},
): Promise<PublishOutcome> => {
  const now = options.clock?.now() ?? new Date();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const key = headKey(date);

  // idempotency: first write wins, byte-for-byte — re-runs return the original
  const existing = await store.get(key);
  if (existing !== null) {
    return {
      published: false,
      reason: 'already_published',
      publication: HeadPublication.parse(JSON.parse(existing)),
    };
  }

  const client = await pool.connect();
  let head: { seq: number; head_hash: string } | null;
  try {
    head = await currentHead(client);
  } finally {
    client.release();
  }
  if (!head) return { published: false, reason: 'empty_ledger' };

  const publication = HeadPublication.parse({ date, seq: head.seq, head_hash: head.head_hash });
  const body = JSON.stringify(publication);
  await store.put(key, body);
  await store.put(`${HEADS_PREFIX}latest.json`, body);
  return { published: true, publication };
};

export type HeadsVerification =
  | { ok: true; checked: number }
  | { ok: false; key: string; problem: string };

/**
 * Cross-check the ledger against every published head (the `--against-heads`
 * mode). Catches what recomputation alone cannot: a chain REWRITTEN
 * consistently (or truncated) still disagrees with the externally-held heads.
 * Fails loudly on the first mismatch.
 */
export const verifyAgainstHeads = async (
  client: pg.ClientBase,
  store: ObjectStore,
): Promise<HeadsVerification> => {
  const keys = (await store.list(HEADS_PREFIX)).filter((key) =>
    /heads\/\d{4}-\d{2}-\d{2}\.json$/.test(key),
  );
  let checked = 0;
  for (const key of keys) {
    const raw = await store.get(key);
    if (raw === null) return { ok: false, key, problem: 'head object listed but unreadable' };
    let publication: HeadPublication;
    try {
      publication = HeadPublication.parse(JSON.parse(raw));
    } catch {
      return { ok: false, key, problem: 'head object is not a valid HeadPublication' };
    }
    const { rows } = await client.query<{ this_hash: string }>(
      'SELECT this_hash FROM events.events WHERE seq = $1',
      [publication.seq],
    );
    if (!rows[0]) {
      return {
        ok: false,
        key,
        problem: `published head covers seq ${publication.seq} but the ledger has no such row — truncated or rewritten`,
      };
    }
    if (rows[0].this_hash !== publication.head_hash) {
      return {
        ok: false,
        key,
        problem: `hash at seq ${publication.seq} is ${rows[0].this_hash} but the published head says ${publication.head_hash} — history rewritten`,
      };
    }
    checked += 1;
  }
  return { ok: true, checked };
};
