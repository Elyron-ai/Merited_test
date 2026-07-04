import { newId, type MeritedEventName } from '@merited/contracts';
import type pg from 'pg';
import { EVENT_CATALOGUE, isCatalogueEvent } from './catalogue.js';
import { canonicalJson } from './canonical-json.js';
import { chainHash, GENESIS_PREV_HASH } from './hash.js';

export class UnregisteredEventError extends Error {
  constructor(name: string) {
    super(`'${name}' is not in the event catalogue — additions are a contracts-first PR (§1)`);
    this.name = 'UnregisteredEventError';
  }
}

export class EmitterFenceError extends Error {
  constructor(name: string, allowlist: readonly string[]) {
    super(`emitter allow-list (SYN-21): '${name}' is not one of [${allowlist.join(', ')}]`);
    this.name = 'EmitterFenceError';
  }
}

export interface AppendOptions {
  /** Emitter allow-list (SYN-21): a scoped emitter (e.g. Valet's ledger
   * mirror) names the ONLY types it may append; anything else throws before
   * touching the database. The DB-level twin is the `valet_emitter_fence`
   * trigger — both layers are tested in VAL-4. */
  allowlist?: readonly MeritedEventName[];
}

export interface AppendedEvent {
  seq: number;
  evt_id: string;
  this_hash: string;
}

/**
 * Append one event to the hash chain (FND-10, B2). MUST be called inside the
 * caller's transaction (transactional outbox: the event commits or rolls back
 * with the business write). Appends are serialised with pg_advisory_xact_lock
 * so the chain is gapless and linear under concurrency.
 */
export const appendEvent = async (
  tx: pg.ClientBase,
  name: MeritedEventName | string,
  data: unknown,
  options: AppendOptions = {},
): Promise<AppendedEvent> => {
  if (!isCatalogueEvent(name)) throw new UnregisteredEventError(name);
  if (options.allowlist && !options.allowlist.includes(name)) {
    throw new EmitterFenceError(name, options.allowlist);
  }
  const body = EVENT_CATALOGUE[name].parse({ type: name, v: 1, data });
  const canonical = canonicalJson(body);

  await tx.query("SELECT pg_advisory_xact_lock(hashtext('merited_events_chain'))");
  const head = await tx.query<{ this_hash: string }>(
    'SELECT this_hash FROM events.events ORDER BY seq DESC LIMIT 1',
  );
  const prevHash = head.rows[0]?.this_hash ?? GENESIS_PREV_HASH;
  const thisHash = chainHash(prevHash, canonical);
  const evtId = newId('evt');

  const inserted = await tx.query<{ seq: string }>(
    `INSERT INTO events.events (evt_id, type, body, prev_hash, this_hash)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING seq`,
    [evtId, name, canonical, prevHash, thisHash],
  );
  const seq = Number(inserted.rows[0]!.seq);
  // Wake subscribers on commit (FND-11); delivery itself never depends on this.
  await tx.query("SELECT pg_notify('merited_events', $1)", [String(seq)]);
  return { seq, evt_id: evtId, this_hash: thisHash };
};

/** Convenience for emitters with no surrounding business transaction. */
export const appendEventInNewTx = async (
  pool: pg.Pool,
  name: MeritedEventName | string,
  data: unknown,
  options: AppendOptions = {},
): Promise<AppendedEvent> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await appendEvent(client, name, data, options);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
