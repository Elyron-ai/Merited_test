import { FIXTURE_IDS } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { migrate } from '../../scripts/migrate.mjs';
import { appendEventInNewTx } from '../append.js';
import { runVerifyChain } from './verify-chain.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cli_${Date.now().toString(36)}`;
const appUrl = () => `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;

let admin: pg.Client;
let appPool: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appPool = new pg.Pool({ connectionString: appUrl(), max: 5 });
  appPool.on('error', () => {});
});

afterAll(async () => {
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('verify-chain CLI (FND-13 accept)', () => {
  it('empty ledger verifies clean', async () => {
    const { code, output } = await runVerifyChain(appUrl());
    expect(code).toBe(0);
    expect(output).toContain('0 events');
  });

  it('clean chain → exit 0 and prints count + head hash', async () => {
    let head = '';
    for (let i = 1; i <= 4; i++) {
      const appended = await appendEventInNewTx(appPool, 'AgentRegistered', {
        agent_id: FIXTURE_IDS.agent,
        name: `agent ${i}`,
        registered_at: '2026-07-04T10:03:00Z',
      });
      head = appended.this_hash;
    }
    const { code, output } = await runVerifyChain(appUrl());
    expect(code).toBe(0);
    expect(output).toContain('4 events');
    expect(output).toContain(`head hash: ${head}`);
  });

  it('superuser tamper of one body → exit 1 naming the seq', async () => {
    const tamper = new pg.Client({
      connectionString: `postgres://merited_admin:merited_dev@localhost:5432/${dbName}`,
    });
    await tamper.connect();
    try {
      await tamper.query(
        `UPDATE events.events SET body = jsonb_set(body, '{data,name}', '"forged"') WHERE seq = 3`,
      );
    } finally {
      await tamper.end();
    }
    const { code, output } = await runVerifyChain(appUrl());
    expect(code).toBe(1);
    expect(output).toContain('CHAIN BROKEN at seq 3');
  });
});
