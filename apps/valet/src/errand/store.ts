import {
  Errand,
  ErrandState,
  type ErrandEvent,
  type MeritedId,
} from '@merited/contracts';
import type pg from 'pg';
import { isTerminal } from './reducer.js';

export interface StoredErrand {
  errand: Errand;
  state: ErrandState;
}

export interface ErrandEventRow {
  seq: number;
  from_state: ErrandState;
  to_state: ErrandState;
  event: ErrandEvent;
  at: string;
}

/** Thrown when the optimistic from-state guard finds the row moved on —
 * the driver reloads and re-derives rather than double-applying. */
export class StaleTransitionError extends Error {
  constructor(errandId: string, from: ErrandState) {
    super(`errand ${errandId} is no longer in ${from}`);
    this.name = 'StaleTransitionError';
  }
}

export interface CreateErrandInput {
  errand_id: MeritedId<'ern'>;
  agent_id: MeritedId<'agt'>;
  brief: Errand['brief'];
  mandate_id?: MeritedId<'mnd'> | null;
  consumer_ref?: string | null;
  sub_hash?: string | null;
}

const isoS = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface ErrandRow {
  errand_id: string;
  agent_id: string;
  state: string;
  brief: unknown;
  mandate_id: string | null;
  approval_id: string | null;
  consumer_ref: string | null;
  sub_hash: string | null;
  quote_id: string | null;
  token: string | null;
  claim_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toStored = (row: ErrandRow): StoredErrand => ({
  errand: Errand.parse({
    errand_id: row.errand_id,
    agent_id: row.agent_id,
    brief: row.brief,
    mandate_id: row.mandate_id,
    approval_id: row.approval_id,
    consumer_ref: row.consumer_ref,
    sub_hash: row.sub_hash,
    quote_id: row.quote_id,
    token: row.token,
    claim_id: row.claim_id,
    created_at: isoS(row.created_at),
    updated_at: isoS(row.updated_at),
  }),
  state: ErrandState.parse(row.state),
});

/** The record fields an event carries with it (event-sourced projection:
 * replaying the log through the reducer + these patches reproduces the row). */
const fieldsFrom = (event: ErrandEvent): Partial<Record<'quote_id' | 'token' | 'approval_id' | 'claim_id', string | null>> => {
  switch (event.type) {
    case 'QUOTE_RECEIVED':
      return { quote_id: event.quote_id, token: event.token };
    case 'APPROVAL_GRANTED':
      // PH2-4: the re-minted apr token replaces the pre-approval one — the
      // original has apr:null and dies APPROVAL_MISSING at verify (§6.4)
      return { approval_id: event.approval_id, ...(event.token ? { token: event.token } : {}) };
    case 'CLAIM_VERIFIED':
      return { claim_id: event.claim_id };
    default:
      return {};
  }
};

const OPEN_STATES = ErrandState.options.filter((state) => !isTerminal(state));

/**
 * Errand persistence (VAL-3, §6.6). Valet-owned schema `valet` (D2), plain
 * SQL like the rest of the repo. `recordTransition` is the PERSIST half of
 * the driver's persist-then-side-effect discipline: the state row and the
 * append-only event log commit in ONE transaction, so a crash never loses
 * an acknowledged state — on restart `loadOpenErrands()` rehydrates and the
 * driver re-enters the current state's side effect idempotently (VAL-6/8).
 */
export class ErrandStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: CreateErrandInput): Promise<StoredErrand> {
    const { rows } = await this.pool.query<ErrandRow>(
      `INSERT INTO valet.errands (errand_id, agent_id, state, brief, mandate_id, consumer_ref, sub_hash)
       VALUES ($1, $2, 'BRIEFED', $3::jsonb, $4, $5, $6)
       RETURNING *`,
      [
        input.errand_id,
        input.agent_id,
        JSON.stringify(input.brief),
        input.mandate_id ?? null,
        input.consumer_ref ?? null,
        input.sub_hash ?? null,
      ],
    );
    return toStored(rows[0]!);
  }

  async get(errandId: string): Promise<StoredErrand | null> {
    const { rows } = await this.pool.query<ErrandRow>(
      `SELECT * FROM valet.errands WHERE errand_id = $1`,
      [errandId],
    );
    return rows[0] ? toStored(rows[0]) : null;
  }

  /** Persist one ACCEPTED transition (the driver has already run the
   * reducer). Optimistic from-state guard: a concurrent or replayed apply
   * finds the row moved on and gets StaleTransitionError instead of a
   * double-apply. */
  async recordTransition(
    errandId: MeritedId<'ern'>,
    from: ErrandState,
    to: ErrandState,
    event: ErrandEvent,
  ): Promise<StoredErrand> {
    const patch = fieldsFrom(event);
    const columns = Object.keys(patch);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sets = ['state = $3', 'updated_at = now()'];
      const params: unknown[] = [errandId, from, to];
      for (const column of columns) {
        params.push(patch[column as keyof typeof patch]);
        sets.push(`${column} = $${params.length}`);
      }
      const updated = await client.query<ErrandRow>(
        `UPDATE valet.errands SET ${sets.join(', ')}
          WHERE errand_id = $1 AND state = $2
          RETURNING *`,
        params,
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new StaleTransitionError(errandId, from);
      }
      await client.query(
        `INSERT INTO valet.errand_events (errand_id, from_state, to_state, event)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [errandId, from, to, JSON.stringify(event)],
      );
      await client.query('COMMIT');
      return toStored(updated.rows[0]!);
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** The append-only per-errand log, in order — replay/debug (VAL-8). */
  async eventLog(errandId: string): Promise<ErrandEventRow[]> {
    const { rows } = await this.pool.query<{
      seq: string;
      from_state: string;
      to_state: string;
      event: unknown;
      at: Date;
    }>(
      `SELECT seq, from_state, to_state, event, at FROM valet.errand_events
        WHERE errand_id = $1 ORDER BY seq`,
      [errandId],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      from_state: ErrandState.parse(row.from_state),
      to_state: ErrandState.parse(row.to_state),
      event: row.event as ErrandEvent,
      at: isoS(row.at),
    }));
  }

  /** Resume set: every errand not yet in a terminal state (VAL-6 restart). */
  async loadOpenErrands(): Promise<StoredErrand[]> {
    const { rows } = await this.pool.query<ErrandRow>(
      `SELECT * FROM valet.errands WHERE state = ANY($1::text[]) ORDER BY created_at`,
      [OPEN_STATES],
    );
    return rows.map(toStored);
  }
}
