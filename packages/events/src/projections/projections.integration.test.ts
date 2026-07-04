import { FIXTURE_IDS } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { migrate } from '../../scripts/migrate.mjs';
import { appendEventInNewTx } from '../append.js';
import { eventsByTypeDay } from './events-by-type-day.js';
import { catchUp, getCursor, rebuildProjection, runProjection } from './framework.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_proj_${Date.now().toString(36)}`;
const at = '2026-07-04T10:03:00Z';

let admin: pg.Client;
let appPool: pg.Pool;

const snapshot = async (): Promise<string> => {
  const { rows } = await appPool.query(
    'SELECT type, day, count FROM events.events_by_type_day ORDER BY type, day',
  );
  return JSON.stringify(rows);
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appPool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  appPool.on('error', () => {});
});

afterAll(async () => {
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('projections framework (FND-12 accept)', () => {
  it('wipe + rebuild from seq 0 is byte-identical to the incrementally-built copy', async () => {
    for (let i = 1; i <= 6; i++) {
      await appendEventInNewTx(appPool, 'AgentRegistered', {
        agent_id: FIXTURE_IDS.agent,
        name: `agent ${i}`,
        registered_at: at,
      });
    }
    await appendEventInNewTx(appPool, 'OfferPublished', {
      offer_id: FIXTURE_IDS.offer,
      merchant_id: FIXTURE_IDS.merchant,
      commitment_id: null,
      published_at: at,
    });

    // incremental build to head
    const appliedIncremental = await catchUp(appPool, eventsByTypeDay);
    expect(appliedIncremental).toBe(7);
    const incremental = await snapshot();
    expect(incremental).toContain('AgentRegistered');
    expect(incremental).toContain('OfferPublished');

    // wipe + full rebuild from seq 0
    const appliedRebuild = await rebuildProjection(appPool, eventsByTypeDay);
    expect(appliedRebuild).toBe(7);
    expect(await snapshot()).toBe(incremental); // byte-identical (§5.9 pattern)
  });

  it('cursor persists across process restart (new runner resumes, no double counting)', async () => {
    const client = await appPool.connect();
    const before = await getCursor(client, eventsByTypeDay.name);
    client.release();
    expect(before).toBe(7);

    // "restart": a fresh live runner picks up from the persisted cursor
    const runner = await runProjection(appPool, eventsByTypeDay, { pollIntervalMs: 50 });
    try {
      await appendEventInNewTx(appPool, 'AgentRegistered', {
        agent_id: FIXTURE_IDS.agent,
        name: 'agent 8',
        registered_at: at,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      await runner.stop();
    }

    const client2 = await appPool.connect();
    const after = await getCursor(client2, eventsByTypeDay.name);
    client2.release();
    expect(after).toBe(8);

    const { rows } = await appPool.query(
      `SELECT count FROM events.events_by_type_day WHERE type = 'AgentRegistered'`,
    );
    expect(Number(rows[0].count)).toBe(7); // 6 + 1 new, never double-counted
  });
});
