import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { verifyChain } from '@merited/events';
import { createFakeShop } from '@merited/fake-aurora';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../scripts/migrate.mjs';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_dur_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'durability-test';
const SIGNER_SECRET = 'trio-test-secret';
const valetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let childEnv: NodeJS.ProcessEnv;

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

interface ChildRun {
  child: ChildProcess;
  lines: string[];
  /** Resolves when a line matching the pattern appears. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  exited: Promise<number | null>;
}

const spawnValet = (args: string[], extraEnv: Record<string, string> = {}): ChildRun => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: valetRoot,
    env: { ...childEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const waiters: Array<{ pattern: RegExp; resolve(line: string): void }> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (waiter.pattern.test(line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => lines.push(`[stderr] ${chunk.toString('utf8').trim()}`));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    lines,
    exited,
    waitFor: (pattern, timeoutMs = 30_000) =>
      new Promise<string>((resolve, reject) => {
        const already = lines.find((l) => pattern.test(l));
        if (already) return resolve(already);
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${pattern}; saw:\n${lines.join('\n')}`)),
          timeoutMs,
        );
        waiters.push({
          pattern,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      }),
  };
};

/** Kill mid-errand at a deterministic boundary, restart, and prove the
 * §6.6 clause: resume from persisted state, one order, no duplicates. */
const killAndResume = async (pauseAt: 'EXECUTING' | 'QUOTED'): Promise<string> => {
  const run = spawnValet(
    ['brief', 'spa day under £120', '--sub-hash', gold.sub_hash, '--max-pence', '12000'],
    { VALET_PAUSE_AT: pauseAt },
  );
  const briefedLine = await run.waitFor(/^Errand ern_[0-9A-Z]+ briefed/);
  const errandId = /Errand (ern_[0-9A-Z]+)/.exec(briefedLine)![1]!;
  await run.waitFor(new RegExp(`^PAUSED_AT ${pauseAt}$`));
  run.child.kill('SIGKILL');
  await run.exited;

  // the paused state was PERSISTED before the side effect ran
  const { rows: parked } = await pool.query(`SELECT state FROM valet.errands WHERE errand_id = $1`, [errandId]);
  expect(parked[0].state).toBe(pauseAt);

  const resume = spawnValet(['resume', errandId]);
  await resume.waitFor(/^Errand finished in state CONFIRMED\.$/, 45_000);
  expect(await resume.exited).toBe(0);
  return errandId;
};

const assertDurable = async (errandId: string): Promise<void> => {
  // completes CONFIRMED with its artefacts persisted
  const { rows } = await pool.query(`SELECT state, token, claim_id FROM valet.errands WHERE errand_id = $1`, [errandId]);
  expect(rows[0]).toMatchObject({ state: 'CONFIRMED' });

  // FakeShop received exactly ONE order for this errand (idempotency held):
  // one webhook delivery → one intake row for the errand's token jti
  const jti = (
    JSON.parse(Buffer.from((rows[0].token as string).split('.')[3]!, 'base64url').toString('utf8')) as {
      jti: string;
    }
  ).jti;
  const { rows: intake } = await pool.query(
    `SELECT count(*)::int AS n FROM core.claims_intake WHERE jti = $1`,
    [jti],
  );
  expect(intake[0].n).toBe(1);

  // ledger trail: no duplicates, no state regression, chain intact
  const { rows: trail } = await pool.query(
    `SELECT body->'data'->>'from' AS from_state, body->'data'->>'to' AS to_state
       FROM events.events WHERE type = 'ErrandStateChanged' AND body->'data'->>'errand_id' = $1 ORDER BY seq`,
    [errandId],
  );
  expect(trail.map((r) => r.to_state)).toEqual(['QUOTED', 'APPROVED', 'EXECUTING', 'CONFIRMED']);
  for (let i = 1; i < trail.length; i += 1) {
    expect(trail[i].from_state).toBe(trail[i - 1].to_state); // linear, no regression
  }

  // the local event log is linear too (persisted-then-side-effect held)
  const { rows: log } = await pool.query(
    `SELECT from_state, to_state FROM valet.errand_events WHERE errand_id = $1 ORDER BY seq`,
    [errandId],
  );
  expect(log[log.length - 1]!.to_state).toBe('CONFIRMED');
  for (let i = 1; i < log.length; i += 1) {
    expect(log[i].from_state).toBe(log[i - 1].to_state);
  }

  const client = await pool.connect();
  try {
    expect(await verifyChain(client)).toMatchObject({ ok: true });
  } finally {
    client.release();
  }
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateValet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});

  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();
  const merchant = (await core.merchants.list())[0]!;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  childEnv = {
    ...process.env,
    MERITED_API_URL: coreUrl,
    FAKESHOP_URL: shopUrl,
    DATABASE_URL: appUrl,
    VALET_DATABASE_URL: `postgres://merited_valet:merited_valet_dev@localhost:5432/${dbName}`,
  };
  delete childEnv['VALET_PAUSE_AT'];
}, 60_000);

afterAll(async () => {
  await shop.close();
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('durability (VAL-8 accept — §6.6: kill and restart mid-errand resumes from persisted state)', () => {
  it('SIGKILL paused at EXECUTING → resume completes CONFIRMED, one order, no duplicate events', async () => {
    const errandId = await killAndResume('EXECUTING');
    await assertDurable(errandId);
  }, 90_000);

  it('SIGKILL paused at QUOTED → resume completes CONFIRMED with the same guarantees', async () => {
    const errandId = await killAndResume('QUOTED');
    await assertDurable(errandId);
  }, 90_000);
});
