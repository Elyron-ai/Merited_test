import { FIXTURE_IDS } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { migrate } from '../../scripts/migrate.mjs';
import { appendEventInNewTx } from '../append.js';
import { subscribe, type DeliveredEvent } from './subscriber.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_sub_${Date.now().toString(36)}`;
const at = '2026-07-04T10:03:00Z';
const agentData = (n: number) => ({
  agent_id: FIXTURE_IDS.agent,
  name: `agent ${n}`,
  registered_at: at,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let admin: pg.Client;
let appPool: pg.Pool;

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

describe('outbox delivery (FND-11 accept)', () => {
  it('delivers events in strict seq order, live via LISTEN wake-up', async () => {
    const received: number[] = [];
    const sub = await subscribe({
      pool: appPool,
      fromSeq: 0,
      handler: (event: DeliveredEvent) => {
        received.push(event.seq);
      },
      pollIntervalMs: 10_000, // poll effectively off — this run rides NOTIFY
    });
    try {
      for (let i = 1; i <= 5; i++) await appendEventInNewTx(appPool, 'AgentRegistered', agentData(i));
      await waitFor(() => received.length >= 5);
      expect(received).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await sub.stop();
    }
  });

  it('with NOTIFY suppressed, the authoritative poll still delivers within the interval', async () => {
    const received: number[] = [];
    const sub = await subscribe({
      pool: appPool,
      fromSeq: 5,
      handler: (event) => {
        received.push(event.seq);
      },
      useListen: false, // NOTIFY artificially suppressed — poll only
      pollIntervalMs: 50,
    });
    try {
      await appendEventInNewTx(appPool, 'AgentRegistered', agentData(6));
      await appendEventInNewTx(appPool, 'AgentRegistered', agentData(7));
      await waitFor(() => received.length >= 2, 3000);
      expect(received).toEqual([6, 7]);
    } finally {
      await sub.stop();
    }
  });

  it('a subscriber stopped mid-stream resumes from its cursor with no gaps', async () => {
    const firstRun: number[] = [];
    const sub1 = await subscribe({
      pool: appPool,
      fromSeq: 7,
      handler: (event) => {
        firstRun.push(event.seq);
      },
      pollIntervalMs: 50,
    });
    await appendEventInNewTx(appPool, 'AgentRegistered', agentData(8));
    await waitFor(() => firstRun.length >= 1);
    await sub1.stop(); // killed mid-stream
    const resumeCursor = sub1.cursor();
    expect(resumeCursor).toBe(8);

    // events land while nobody is subscribed
    await appendEventInNewTx(appPool, 'AgentRegistered', agentData(9));
    await appendEventInNewTx(appPool, 'AgentRegistered', agentData(10));

    const secondRun: number[] = [];
    const sub2 = await subscribe({
      pool: appPool,
      fromSeq: resumeCursor,
      handler: (event) => {
        secondRun.push(event.seq);
      },
      pollIntervalMs: 50,
    });
    try {
      await waitFor(() => secondRun.length >= 2);
      expect(secondRun).toEqual([9, 10]); // no gaps, no repeats past the cursor
      expect([...firstRun, ...secondRun]).toEqual([8, 9, 10]);
    } finally {
      await sub2.stop();
    }
  });
});
