import { FIXTURE_IDS } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import Fastify from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inRequestSpan, registerTracing } from './fastify-plugin.js';
import { createLogger } from './logger.js';
import { getMemoryExporter, initOtel, injectTraceparent, shutdownOtel, withSpan } from './sdk.js';

/**
 * FND-14 harness: service A calls service B; B writes a DB row and appends a
 * ledger event. Every span — A server, A→B client, B server, B pg insert,
 * B ledger append — must share ONE trace ID (§8: the demo's backbone).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_otel_${Date.now().toString(36)}`;

let admin: pg.Client;
let appPool: pg.Pool;
const serviceA = Fastify();
const serviceB = Fastify();
let urlB = '';

beforeAll(async () => {
  initOtel({ serviceName: 'otel-harness', exporter: 'memory' });

  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain-JS script module
  const { migrate } = await import('../../events/scripts/migrate.mjs');
  await migrate(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  appPool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  appPool.on('error', () => {});

  registerTracing(serviceB, 'service-b');
  serviceB.post('/write', async (req) =>
    inRequestSpan(req as never, async () => {
      await withSpan('pg.insert events_by_type_day', async () => {
        await appPool.query(
          `INSERT INTO events.events_by_type_day (type, day, count) VALUES ('OtelHarness', '2026-07-04', 1)
           ON CONFLICT (type, day) DO UPDATE SET count = events.events_by_type_day.count + 1`,
        );
      });
      await withSpan('events.append AgentRegistered', () =>
        appendEventInNewTx(appPool, 'AgentRegistered', {
          agent_id: FIXTURE_IDS.agent,
          name: 'otel harness',
          registered_at: '2026-07-04T10:03:00Z',
        }),
      );
      return { ok: true };
    }),
  );
  urlB = await serviceB.listen({ port: 0, host: '127.0.0.1' });

  registerTracing(serviceA, 'service-a');
  serviceA.post('/orchestrate', async (req) =>
    inRequestSpan(req as never, () =>
      withSpan('call service-b', async () => {
        const response = await fetch(`${urlB}/write`, {
          method: 'POST',
          headers: injectTraceparent({ 'content-type': 'application/json' }),
          body: '{}',
        });
        return response.json();
      }),
    ),
  );
});

afterAll(async () => {
  await serviceA.close();
  await serviceB.close();
  await appPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('one trace ID end-to-end (FND-14 accept)', () => {
  it('A → B → pg write + ledger append all share a single trace ID', async () => {
    const response = await serviceA.inject({ method: 'POST', url: '/orchestrate', payload: {} });
    expect(response.statusCode).toBe(200);

    const spans = getMemoryExporter()!.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'POST /orchestrate',
        'call service-b',
        'POST /write',
        'pg.insert events_by_type_day',
        'events.append AgentRegistered',
      ]),
    );
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1); // ONE trace ID across the HTTP hop + pg spans

    // parentage: B's server span is a child of A's client span (the HTTP hop)
    const client = spans.find((s) => s.name === 'call service-b')!;
    const serverB = spans.find((s) => s.name === 'POST /write')!;
    expect(serverB.parentSpanContext?.spanId).toBe(client.spanContext().spanId);
  });

  it('logger injects trace_id/span_id and redacts token fields', async () => {
    const lines: string[] = [];
    const logger = createLogger('harness', {
      write: (line: string) => {
        lines.push(line);
      },
    });
    await withSpan('log-span', () => {
      logger.info({ refresh_token: 'super-secret', ok: true }, 'inside span');
    });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(entry['span_id']).toMatch(/^[0-9a-f]{16}$/);
    expect(entry['refresh_token']).toBe('[Redacted]');
    expect(JSON.stringify(entry)).not.toContain('super-secret');
  });
});
