import { FIXTURE_IDS } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { migrate } from '../scripts/migrate.mjs';
import { appendEventInNewTx, UnregisteredEventError } from './append.js';
import { GENESIS_PREV_HASH } from './hash.js';
import { verifyChain } from './verify.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_chain_${Date.now().toString(36)}`;
const at = '2026-07-04T10:03:00Z';
const agentData = (n: number) => ({
  agent_id: FIXTURE_IDS.agent,
  name: `agent ${n}`,
  registered_at: at,
});

let admin: pg.Client;
let appPool: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appPool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 40,
  });
  // DROP … WITH (FORCE) in teardown races socket close; swallow late idle-client FATALs.
  appPool.on('error', () => {});
});

afterAll(async () => {
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('event append core (FND-10 accept)', () => {
  it('genesis: the first event hashes from 64×"0"', async () => {
    const appended = await appendEventInNewTx(appPool, 'AgentRegistered', agentData(0));
    expect(appended.seq).toBe(1);
    const { rows } = await appPool.query('SELECT prev_hash, this_hash FROM events.events WHERE seq = 1');
    expect(rows[0].prev_hash).toBe(GENESIS_PREV_HASH);
    expect(rows[0].this_hash).toBe(appended.this_hash);
  });

  it('rejects unregistered event types with no DB write', async () => {
    const before = await appPool.query('SELECT count(*) FROM events.events');
    await expect(appendEventInNewTx(appPool, 'RogueEvent', {})).rejects.toThrow(
      UnregisteredEventError,
    );
    const after = await appPool.query('SELECT count(*) FROM events.events');
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('rejects invalid payloads (Zod) and hash-unsafe data pre-insert', async () => {
    await expect(
      appendEventInNewTx(appPool, 'AgentRegistered', { agent_id: 'not-an-id', name: 'x', registered_at: at }),
    ).rejects.toThrow();
  });

  it('32 concurrent appends yield a gapless, valid chain', async () => {
    const before = await appPool.query('SELECT max(seq) AS m FROM events.events');
    const base = Number(before.rows[0].m ?? 0);
    await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        appendEventInNewTx(appPool, 'AgentRegistered', agentData(i + 1)),
      ),
    );
    const { rows } = await appPool.query('SELECT count(*) AS c, max(seq) AS m FROM events.events');
    expect(Number(rows[0].m)).toBe(base + 32);

    const client = await appPool.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification).toMatchObject({ ok: true });
      if (verification.ok) expect(verification.count).toBe(base + 32);
    } finally {
      client.release();
    }
  });

  it('UPDATE and DELETE as merited_app fail with 42501 (append-only in Postgres)', async () => {
    const update = appPool.query(`UPDATE events.events SET type = 'Tampered' WHERE seq = 1`);
    await expect(update).rejects.toMatchObject({ code: '42501' });
    const del = appPool.query('DELETE FROM events.events WHERE seq = 1');
    await expect(del).rejects.toMatchObject({ code: '42501' });
  });

  it('verifyChain detects a tampered body (via a role that bypasses the REVOKE)', async () => {
    const tamperAdmin = new pg.Client({
      connectionString: `postgres://merited_admin:merited_dev@localhost:5432/${dbName}`,
    });
    await tamperAdmin.connect();
    try {
      await tamperAdmin.query(
        `UPDATE events.events SET body = jsonb_set(body, '{data,name}', '"forged"') WHERE seq = 2`,
      );
      const client = await appPool.connect();
      try {
        const verification = await verifyChain(client);
        expect(verification.ok).toBe(false);
        if (!verification.ok) expect(verification.broken_seq).toBe(2);
      } finally {
        client.release();
      }
    } finally {
      await tamperAdmin.end();
    }
  });
});
