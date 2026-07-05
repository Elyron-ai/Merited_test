import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newId, type HeadPublication } from '@merited/contracts';
import { appendEventInNewTx, FakeObjectStore } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
import { HeadPublicationJob } from './head-publication-job.js';

/**
 * PH1-21 (core side): the scheduled job publishes once per day (idempotent —
 * hourly ticks are safe), fires the optional per-merchant webhooks exactly
 * once per NEW publication, and a webhook failure never blocks publication.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_hpj_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let storeDir: string;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 3,
  });
  pool.on('error', () => {});
  await appendEventInNewTx(pool, 'AgentRegistered', {
    agent_id: newId('agt'),
    name: 'head-job-test',
    registered_at: '2026-07-05T09:00:00Z',
  });
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'merited-hpj-'));
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await rm(storeDir, { recursive: true, force: true });
});

describe('head-publication job (PH1-21)', () => {
  it('publishes once per day; ticks are idempotent; webhooks fire once per NEW publication', async () => {
    const delivered: HeadPublication[] = [];
    const job = new HeadPublicationJob({
      pool,
      store: new FakeObjectStore(storeDir),
      clock: { now: () => new Date('2026-07-05T06:00:00Z') },
      webhooks: [
        (publication) => {
          delivered.push(publication);
          return Promise.resolve();
        },
        () => Promise.reject(new Error('merchant endpoint down')), // must not block
      ],
    });

    const first = await job.runOnce();
    expect(first.published).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ date: '2026-07-05', seq: 1 });

    // the hourly tick later the same day: no re-publication, no re-delivery
    const second = await job.runOnce();
    expect(second.published).toBe(false);
    expect(delivered).toHaveLength(1);
  });
});
