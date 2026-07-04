import { getMemoryExporter, initOtel, injectTraceparent, shutdownOtel, withSpan } from '@merited/otel';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
import { createTrioServer } from './server.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_trio_${Date.now().toString(36)}`;
const TOKEN = 'trio-test-service-token';

let admin: pg.Client;
let appPool: pg.Pool;
const app = createTrioServer({ serviceToken: TOKEN });

beforeAll(async () => {
  app.get('/probe', async () => ({ ok: true }));
  initOtel({ serviceName: 'trio-test', exporter: 'memory' });
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateTrio(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appPool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  appPool.on('error', () => {});
});

afterAll(async () => {
  await app.close();
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('trio scaffold (TRIO-3 accept)', () => {
  it('boots and answers /healthz without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: 'trio' });
  });

  it('migration applies: the trio table set exists', async () => {
    const { rows } = await appPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'trio' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const expected of [
      'commitments',
      'commitment_terminations',
      'minted_tokens',
      'consumed_jtis',
      'entry_sets',
      'entry_lines',
      'counters',
      'idempotency_keys',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('UPDATE on trio.commitments as the app role fails (append-only in Postgres)', async () => {
    await appPool.query(
      `INSERT INTO trio.commitments (commitment_id, merchant_id, offer_ref, body)
       VALUES ('com_TESTROW', 'mer_x', 'off_x', '{}'::jsonb)`,
    );
    await expect(
      appPool.query(`UPDATE trio.commitments SET merchant_id = 'mer_forged' WHERE commitment_id = 'com_TESTROW'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      appPool.query(`DELETE FROM trio.commitments WHERE commitment_id = 'com_TESTROW'`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('service auth: missing/wrong token → 401; correct token → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/probe',
          headers: { 'x-merited-service-token': 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/probe',
          headers: { 'x-merited-service-token': TOKEN },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('a request produces a trace span parented to the caller (traceparent joined)', async () => {
    await withSpan('caller-root', async () => {
      const headers = injectTraceparent({ 'x-merited-service-token': TOKEN });
      await app.inject({ method: 'GET', url: '/probe', headers });
    });
    const spans = getMemoryExporter()!.getFinishedSpans();
    const caller = spans.find((s) => s.name === 'caller-root')!;
    const server = spans.filter((s) => s.name === 'GET /probe').at(-1)!;
    expect(server.spanContext().traceId).toBe(caller.spanContext().traceId);
    expect(server.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
  });
});
