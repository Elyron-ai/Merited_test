import { newId, type Errand, type ErrandState } from '@merited/contracts';
import { appendEventInNewTx, EmitterFenceError, verifyChain } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import { EventsPackageMirror } from './ledger-mirror.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_mirror_${Date.now().toString(36)}`;

let admin: pg.Client;
let valetPool: pg.Pool; // connected as merited_valet — the fenced credential
let appPool: pg.Pool;
let mirror: EventsPackageMirror;

const errand: Errand = {
  errand_id: newId('ern'),
  agent_id: 'agt_01J00000000000000000000000',
  brief: { text: 'spa day under £120', max_price: null, sub_hash: null },
  mandate_id: null,
  approval_id: null,
  consumer_ref: null,
  sub_hash: null,
  quote_id: 'qte_01J00000000000000000000000',
  token: 'v4.public.fake.tok.sig',
  claim_id: null,
  created_at: '2026-07-04T10:00:00Z',
  updated_at: '2026-07-04T10:00:00Z',
};

const at = '2026-07-04T10:01:00Z';

const eventCount = async (): Promise<number> => {
  const { rows } = await appPool.query(`SELECT count(*)::int AS n FROM events.events`);
  return rows[0].n as number;
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  valetPool = new pg.Pool({
    connectionString: `postgres://merited_valet:merited_valet_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  valetPool.on('error', () => {});
  appPool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  appPool.on('error', () => {});
  mirror = new EventsPackageMirror(valetPool);
});

afterAll(async () => {
  await valetPool.end();
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('ledger mirror (VAL-4 accept — §6.6: every transition from QUOTED onward is mirrored)', () => {
  it('BRIEFED→SEARCHING mirrors NOTHING (wallet-DB-only per §3)', async () => {
    const before = await eventCount();
    const result = await mirror.mirror({ errand, from: 'BRIEFED', to: 'SEARCHING', at });
    expect(result).toEqual({ mirrored: false });
    expect(await eventCount()).toBe(before);
  });

  it('SEARCHING→QUOTED and every later transition each append exactly ONE ErrandStateChanged', async () => {
    const walk: Array<[ErrandState, ErrandState]> = [
      ['SEARCHING', 'QUOTED'],
      ['QUOTED', 'AWAITING_APPROVAL'],
      ['AWAITING_APPROVAL', 'APPROVED'],
      ['APPROVED', 'EXECUTING'],
      ['EXECUTING', 'FAILED'],
      ['FAILED', 'EXECUTING'], // RETRY re-entry is platform history too
      ['EXECUTING', 'CONFIRMED'],
    ];
    for (const [from, to] of walk) {
      const before = await eventCount();
      const result = await mirror.mirror({ errand, from, to, at });
      expect(result.mirrored).toBe(true);
      expect(await eventCount()).toBe(before + 1);
    }
    const { rows } = await appPool.query(
      `SELECT body->'data'->>'errand_id' AS errand_id, body->'data'->>'to' AS to_state
         FROM events.events WHERE type = 'ErrandStateChanged' ORDER BY seq`,
    );
    expect(rows).toHaveLength(walk.length);
    expect(rows.every((r) => r.errand_id === errand.errand_id)).toBe(true);
    expect(rows.map((r) => r.to_state)).toEqual(walk.map(([, to]) => to));
  });

  it("the mirrored events EXTEND the hash chain — verify-chain passes over the errand's history", async () => {
    const client = await appPool.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification).toMatchObject({ ok: true });
      if (verification.ok) expect(verification.count).toBeGreaterThanOrEqual(7);
    } finally {
      client.release();
    }
  });

  it('FENCE, DB layer (SYN-21): the merited_valet role cannot append any other catalogue event', async () => {
    const before = await eventCount();
    await expect(
      appendEventInNewTx(valetPool, 'AgentRegistered', {
        agent_id: 'agt_01J00000000000000000000000',
        name: 'rogue valet',
        registered_at: at,
      }),
    ).rejects.toThrow(/valet emitter fence/);
    expect(await eventCount()).toBe(before); // nothing landed
  });

  it('FENCE, code layer (SYN-21): the allow-list refuses before touching the database', async () => {
    await expect(
      appendEventInNewTx(
        valetPool,
        'AgentRegistered',
        { agent_id: 'agt_01J00000000000000000000000', name: 'x', registered_at: at },
        { allowlist: ['ErrandStateChanged'] },
      ),
    ).rejects.toThrow(EmitterFenceError);
  });

  it('FENCE, append-only (§8): merited_valet cannot UPDATE or DELETE ledger rows', async () => {
    await expect(valetPool.query(`UPDATE events.events SET type = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(valetPool.query(`DELETE FROM events.events`)).rejects.toThrow(/permission denied/);
  });
});
