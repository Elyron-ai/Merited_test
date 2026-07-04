import type pg from 'pg';
import type { DeliveredEvent } from '../deliver/subscriber.js';
import { subscribe, type Subscription } from '../deliver/subscriber.js';

/**
 * Projections framework (FND-12, B2): projections are DISPOSABLE read models
 * over the ledger — rebuildable from seq 0 at any time. The ledger is the
 * source of truth; a projection never is (§5.9).
 */
export interface Projection {
  name: string;
  /** Event types this projection consumes; others are skipped (cursor still advances). */
  handles: readonly string[];
  apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void>;
  /** Delete all projection rows (used by rebuild). */
  reset(client: pg.ClientBase): Promise<void>;
}

export const getCursor = async (client: pg.ClientBase, name: string): Promise<number> => {
  const { rows } = await client.query<{ last_seq: string }>(
    'SELECT last_seq FROM events.projection_cursors WHERE projection_name = $1',
    [name],
  );
  return rows[0] ? Number(rows[0].last_seq) : 0;
};

export const setCursor = async (
  client: pg.ClientBase,
  name: string,
  seq: number,
): Promise<void> => {
  await client.query(
    `INSERT INTO events.projection_cursors (projection_name, last_seq, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (projection_name) DO UPDATE SET last_seq = $2, updated_at = now()`,
    [name, seq],
  );
};

/** Apply one event + advance the cursor atomically (one transaction). */
const applyWithCursor = async (
  pool: pg.Pool,
  projection: Projection,
  event: DeliveredEvent,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (projection.handles.includes(event.type)) {
      await projection.apply(client, event);
    }
    await setCursor(client, projection.name, event.seq);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Live tailing via the FND-11 subscriber, resuming from the persisted cursor. */
export const runProjection = async (
  pool: pg.Pool,
  projection: Projection,
  options: { pollIntervalMs?: number; useListen?: boolean } = {},
): Promise<Subscription> => {
  const client = await pool.connect();
  let fromSeq: number;
  try {
    fromSeq = await getCursor(client, projection.name);
  } finally {
    client.release();
  }
  return subscribe({
    pool,
    fromSeq,
    handler: (event) => applyWithCursor(pool, projection, event),
    ...options,
  });
};

/** Catch a projection up to the current head, one pass, no live tail. */
export const catchUp = async (pool: pg.Pool, projection: Projection): Promise<number> => {
  let applied = 0;
  for (;;) {
    const cursorClient = await pool.connect();
    let cursor: number;
    try {
      cursor = await getCursor(cursorClient, projection.name);
    } finally {
      cursorClient.release();
    }
    const { rows } = await pool.query<{
      seq: string;
      evt_id: string;
      type: string;
      body: unknown;
      created_at: string;
    }>(
      `SELECT seq, evt_id, type, body, created_at
         FROM events.events WHERE seq > $1 ORDER BY seq ASC LIMIT 500`,
      [cursor],
    );
    if (rows.length === 0) return applied;
    for (const row of rows) {
      await applyWithCursor(pool, projection, { ...row, seq: Number(row.seq) });
      applied += 1;
    }
  }
};

/** Wipe + replay from seq 0 (§5.9: projections disposable, the ledger isn't). */
export const rebuildProjection = async (pool: pg.Pool, projection: Projection): Promise<number> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await projection.reset(client);
    await setCursor(client, projection.name, 0);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return catchUp(pool, projection);
};
