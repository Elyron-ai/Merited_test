import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { migrate } from '../scripts/migrate.mjs';
import { createAppPool } from './db.js';

/** Integration tests — require the docker-compose Postgres (CLAUDE.md env). */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_it_${Date.now().toString(36)}`;

let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('migration runner (FND-9 accept)', () => {
  const freshUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;

  it('applies cleanly from an empty database, then re-runs as a no-op', async () => {
    const first = await migrate(freshUrl);
    expect(first).toContain('0000_baseline');
    const second = await migrate(freshUrl);
    expect(second).toEqual([]);
  });

  it('refuses to run as any role other than merited_migrate', async () => {
    await expect(
      migrate(`postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`),
    ).rejects.toThrow(/merited_migrate/);
  });

  it('runtime pool connects as merited_app only (D8)', async () => {
    const pool = createAppPool();
    try {
      const { rows } = await pool.query('SELECT current_user');
      expect(rows[0].current_user).toBe('merited_app');
    } finally {
      await pool.end();
    }
  });
});
