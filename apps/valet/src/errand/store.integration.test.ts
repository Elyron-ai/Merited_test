import { newId, type ErrandEvent, type ErrandState, type MeritedId } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../../scripts/migrate.mjs';
import { transition } from './reducer.js';
import { ErrandStore, StaleTransitionError, type StoredErrand } from './store.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_valet_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let appUrl: string;
let store: ErrandStore;

const AGENT = 'agt_01J00000000000000000000000' as MeritedId<'agt'>;
const BRIEF = { text: 'spa day under £120', max_price: { amount: 12000, currency: 'GBP_pence' as const }, sub_hash: null };

const EVENTS: Record<string, ErrandEvent> = {
  search: { type: 'SEARCH_STARTED' },
  quote: { type: 'QUOTE_RECEIVED', quote_id: 'qte_01J00000000000000000000000', token: 'v4.public.fake.tok.sig' },
  request: { type: 'APPROVAL_REQUESTED' },
  grant: { type: 'APPROVAL_GRANTED', approval_id: 'apr_01J00000000000000000000000', mode: 'explicit' },
  skip: { type: 'APPROVAL_SKIPPED', reason: 'walletless' },
  decline: { type: 'APPROVAL_DECLINED' },
  execute: { type: 'EXECUTION_STARTED' },
  verified: { type: 'CLAIM_VERIFIED', claim_id: 'clm_01J00000000000000000000000' },
  rejected: { type: 'CLAIM_REJECTED', reason_code: 'TOKEN_REPLAYED' },
  timeout: { type: 'TIMED_OUT', cause: 'quote expired' },
  retry: { type: 'RETRY' },
};

/** Apply through the store WITH a fresh pool+store each step — every accepted
 * transition must survive a "process restart" and rehydrate identically. */
const applyAndRehydrate = async (errandId: MeritedId<'ern'>, event: ErrandEvent): Promise<StoredErrand> => {
  const current = (await store.get(errandId))!;
  const result = transition(current.state, event);
  if ('error' in result) throw new Error(`reducer rejected ${current.state} × ${event.type}`);
  const persisted = await store.recordTransition(errandId, current.state, result.next, event);

  const freshPool = new pg.Pool({ connectionString: appUrl, max: 2 });
  try {
    const rehydrated = await new ErrandStore(freshPool).get(errandId);
    expect(rehydrated).toEqual(persisted); // identical state after "restart"
  } finally {
    await freshPool.end();
  }
  return persisted;
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateValet(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});
  store = new ErrandStore(pool);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('errand store (VAL-3 accept)', () => {
  it('round-trips an errand through the FULL wallet path to CONFIRMED, rehydrating identically at every step', async () => {
    const id = newId('ern');
    const created = await store.create({ errand_id: id, agent_id: AGENT, brief: BRIEF });
    expect(created.state).toBe('BRIEFED');
    expect(created.errand.brief).toEqual(BRIEF);

    await applyAndRehydrate(id, EVENTS.search!);
    const quoted = await applyAndRehydrate(id, EVENTS.quote!);
    expect(quoted.errand.quote_id).toBe('qte_01J00000000000000000000000');
    expect(quoted.errand.token).toBe('v4.public.fake.tok.sig');
    await applyAndRehydrate(id, EVENTS.request!);
    const approved = await applyAndRehydrate(id, EVENTS.grant!);
    expect(approved.errand.approval_id).toBe('apr_01J00000000000000000000000');
    await applyAndRehydrate(id, EVENTS.execute!);
    const confirmed = await applyAndRehydrate(id, EVENTS.verified!);
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.errand.claim_id).toBe('clm_01J00000000000000000000000');

    // the append-only log replays through the REDUCER to the stored state
    const log = await store.eventLog(id);
    expect(log.map((row) => row.to_state)).toEqual([
      'SEARCHING', 'QUOTED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'CONFIRMED',
    ]);
    const replayed = log.reduce<ErrandState>((state, row) => {
      const result = transition(state, row.event);
      if ('error' in result) throw new Error('log does not replay');
      return result.next;
    }, 'BRIEFED');
    expect(replayed).toBe(confirmed.state);
  });

  it('reaches every remaining state: DECLINED, EXPIRED, and FAILED → RETRY → EXECUTING', async () => {
    const declined = newId('ern');
    await store.create({ errand_id: declined, agent_id: AGENT, brief: BRIEF });
    for (const e of [EVENTS.search!, EVENTS.quote!, EVENTS.request!, EVENTS.decline!]) {
      await applyAndRehydrate(declined, e);
    }
    expect((await store.get(declined))!.state).toBe('DECLINED');

    const expired = newId('ern');
    await store.create({ errand_id: expired, agent_id: AGENT, brief: BRIEF });
    for (const e of [EVENTS.search!, EVENTS.quote!, EVENTS.timeout!]) {
      await applyAndRehydrate(expired, e);
    }
    expect((await store.get(expired))!.state).toBe('EXPIRED');

    const retried = newId('ern');
    await store.create({ errand_id: retried, agent_id: AGENT, brief: BRIEF });
    for (const e of [EVENTS.search!, EVENTS.quote!, EVENTS.skip!, EVENTS.execute!, EVENTS.rejected!, EVENTS.retry!]) {
      await applyAndRehydrate(retried, e);
    }
    expect((await store.get(retried))!.state).toBe('EXECUTING'); // D4 skip + retry edge
  });

  it('loadOpenErrands returns exactly the non-terminal errands (the resume set)', async () => {
    const open = await store.loadOpenErrands();
    const states = new Set(open.map((s) => s.state));
    for (const state of states) {
      expect(['CONFIRMED', 'DECLINED', 'EXPIRED']).not.toContain(state);
    }
    // the retried errand (EXECUTING) is in the resume set
    expect(open.some((s) => s.state === 'EXECUTING')).toBe(true);
  });

  it('the optimistic from-state guard refuses a stale apply: no state change, no log row', async () => {
    const id = newId('ern');
    await store.create({ errand_id: id, agent_id: AGENT, brief: BRIEF });
    await store.recordTransition(id, 'BRIEFED', 'SEARCHING', EVENTS.search!);

    await expect(
      store.recordTransition(id, 'BRIEFED', 'SEARCHING', EVENTS.search!), // stale: already SEARCHING
    ).rejects.toThrow(StaleTransitionError);
    expect((await store.get(id))!.state).toBe('SEARCHING');
    expect(await store.eventLog(id)).toHaveLength(1);
  });

  it('the per-errand log is APPEND-ONLY for the runtime role (UPDATE/DELETE denied)', async () => {
    await expect(pool.query(`UPDATE valet.errand_events SET to_state = 'CONFIRMED'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(pool.query(`DELETE FROM valet.errand_events`)).rejects.toThrow(/permission denied/);
  });
});
