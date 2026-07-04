import type pg from 'pg';

export interface DeliveredEvent {
  seq: number;
  evt_id: string;
  type: string;
  body: unknown;
  created_at: string;
}

export interface SubscribeOptions {
  pool: pg.Pool;
  /** Deliver events with seq strictly greater than this. Caller persists it. */
  fromSeq: number;
  handler: (event: DeliveredEvent) => Promise<void> | void;
  /** Authoritative poll cadence — delivery never depends on NOTIFY. */
  pollIntervalMs?: number;
  /** LISTEN is a wake-up optimisation only; set false to run poll-only. */
  useListen?: boolean;
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export interface Subscription {
  stop(): Promise<void>;
  /** Last seq successfully handled (the caller's resume cursor). */
  cursor(): number;
}

/**
 * Outbox delivery (FND-11, B2): LISTEN `merited_events` as a wake-up, with a
 * cursor-ordered poll over `seq` as the authoritative path — a missed
 * notification can never lose an event, only delay it one poll interval.
 *
 * Semantics: at-least-once, strict seq order within a subscription. The
 * handler is awaited per event; the in-memory cursor advances only after the
 * handler resolves, so a crash re-delivers the in-flight event on resume.
 * Handlers must therefore be idempotent or rebuildable (FND-12 projections).
 */
export const subscribe = async (options: SubscribeOptions): Promise<Subscription> => {
  const {
    pool,
    fromSeq,
    handler,
    pollIntervalMs = 250,
    useListen = true,
    batchSize = 200,
    onError = () => {},
  } = options;

  let cursor = fromSeq;
  let stopped = false;
  let draining = false;
  let listenClient: pg.PoolClient | null = null;

  const drain = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        const { rows } = await pool.query<{
          seq: string;
          evt_id: string;
          type: string;
          body: unknown;
          created_at: string;
        }>(
          `SELECT seq, evt_id, type, body, created_at
             FROM events.events WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
          [cursor, batchSize],
        );
        if (rows.length === 0 || stopped) break;
        for (const row of rows) {
          if (stopped) break;
          await handler({ ...row, seq: Number(row.seq) });
          cursor = Number(row.seq);
        }
        if (rows.length < batchSize) break;
      }
    } catch (error) {
      onError(error);
    } finally {
      draining = false;
    }
  };

  if (useListen) {
    listenClient = await pool.connect();
    listenClient.on('notification', () => void drain());
    listenClient.on('error', onError);
    await listenClient.query('LISTEN merited_events');
  }

  const interval = setInterval(() => void drain(), pollIntervalMs);
  await drain(); // catch up immediately on subscribe

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (listenClient) {
        try {
          await listenClient.query('UNLISTEN merited_events');
        } catch {
          // connection may already be gone — stop() must not throw
        }
        listenClient.release();
      }
    },
    cursor: () => cursor,
  };
};
