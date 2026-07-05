import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, type Decisioner, type EligibleOffer } from '@merited/contracts';
import { catchUp } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { createSimulatedCore, type SimulatedCore } from '../../testing.js';
import { analyticsProjection } from '../analytics/projections/index.js';
import { HttpDecisioner } from './http-decisioner.js';
import { PassthroughDecisioner } from './index.js';

/**
 * PH2-7 accept — the Phase-2 gate clause made CI: the read-path runs
 * against RulesDecisioner, RandomDecisioner AND HttpDecisioner (the real
 * Python sidecar serving the PH2-8 model) and the response SCHEMAS diff
 * empty — swapping decisioners changes ranking only. Sidecar down →
 * deterministic rules fallback; reads never fail.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_swap_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'swap-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let sidecar: ChildProcess | null = null;
let sidecarUrl = '';
let modelDir = '';
const cores: SimulatedCore[] = [];
let appUrl = '';
let trioUrl = '';
let subHash = '';

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

/** Structural shape: values → their types, keys preserved — the "schema
 * diff" the gate clause demands (must be empty across decisioners). */
const shapeOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
};

const coreFor = async (decisioner: string): Promise<SimulatedCore> => {
  const core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
    decisioner,
  });
  cores.push(core);
  await core.listen();
  return core;
};

const readVia = async (core: SimulatedCore, agentKey: string) => {
  const address = core.app.server.address() as { port: number };
  const response = await fetch(
    `http://127.0.0.1:${address.port}/v1/offers?sub_hash=${encodeURIComponent(subHash)}`,
    { headers: { 'x-merited-agent-key': agentKey } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { quotes: Array<{ offer_id: string }> };
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});

  const { runSeed, AURORA_MEMBERS } = await import('@merited/seed');
  const { generateTraffic } = await import('@merited/seed/traffic');
  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });
  subHash = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!.sub_hash;

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  trioUrl = await trio.listen();

  // the PH2-8 model over synthetic exhaust, served by the REAL sidecar
  await generateTraffic(pool, { seed: 11, merchants: 5, days: 15, mintsPerDay: 5, baseDate: '2026-07-01' });
  await catchUp(pool, analyticsProjection);
  modelDir = mkdtempSync(path.join(os.tmpdir(), 'merited-swap-'));
  execSync('python3 training/train.py', {
    cwd: path.join(repoRoot, 'apps/ml-decisioner'),
    env: { ...process.env, MERITED_DATABASE_URL: appUrl, MERITED_MODEL_DIR: modelDir },
    timeout: 180_000,
  });
  const sidecarPort = await freePort();
  sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  sidecar = spawn('python3', ['sidecar/serve.py'], {
    cwd: path.join(repoRoot, 'apps/ml-decisioner'),
    env: {
      ...process.env,
      MERITED_DATABASE_URL: appUrl,
      MERITED_MODEL_DIR: modelDir,
      MERITED_SIDECAR_PORT: String(sidecarPort),
    },
    stdio: 'pipe',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${sidecarUrl}/healthz`)).ok) break;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}, 300_000);

afterAll(async () => {
  sidecar?.kill('SIGTERM');
  for (const core of cores) await core.close();
  await trio.close();
  await pool.end();
  rmSync(modelDir, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-7: decisioner swap — zero API changes, proved in CI', () => {
  it('GATE CLAUSE: rules vs random vs the REAL sidecar — response schema diff is EMPTY; ranking is all that may differ', async () => {
    const rules = await coreFor('rules');
    const agentKey = (await rules.agents.register({ name: 'SwapProbe', contact: 'swap@merited.test' })).api_key;
    const random = await coreFor('random:3');
    const http = await coreFor(sidecarUrl);

    const responses = {
      rules: await readVia(rules, agentKey),
      random: await readVia(random, agentKey),
      http: await readVia(http, agentKey),
    };
    // every decisioner sees the same OFFERS (set equality)…
    const ids = (r: { quotes: Array<{ offer_id: string }> }) => [...r.quotes.map((q) => q.offer_id)].sort();
    expect(ids(responses.random)).toEqual(ids(responses.rules));
    expect(ids(responses.http)).toEqual(ids(responses.rules));
    expect(responses.rules.quotes.length).toBeGreaterThan(0);

    // …and the SCHEMA diff is empty: per-offer structural shapes identical
    const shapesBy = (r: { quotes: Array<{ offer_id: string }> }) =>
      Object.fromEntries(r.quotes.map((q) => [q.offer_id, shapeOf(q)]));
    expect(shapesBy(responses.random)).toEqual(shapesBy(responses.rules));
    expect(shapesBy(responses.http)).toEqual(shapesBy(responses.rules));
  }, 120_000);

  it('sidecar DOWN → the read succeeds with the DETERMINISTIC rules ranking (fallback, never a failure)', async () => {
    const deadPort = await freePort(); // freed immediately — nothing listens
    const rules = await coreFor('rules');
    const agentKey = (await rules.agents.register({ name: 'FallbackProbe', contact: 'fb@merited.test' })).api_key;
    const dead = await coreFor(`http://127.0.0.1:${deadPort}`);

    const fromRules = await readVia(rules, agentKey);
    const fromDead = await readVia(dead, agentKey);
    expect(fromDead.quotes.map((q) => q.offer_id)).toEqual(fromRules.quotes.map((q) => q.offer_id));
  }, 60_000);

  it('a sidecar answer that is NOT a permutation is refused wholesale — fallback order wins', async () => {
    const eligible: EligibleOffer[] = [0, 1].map(() => ({
      offer: {
        offer_id: newId('off'), merchant_id: newId('mer'), title: 't', description: 'd',
        mechanics: { type: 'percentage_off', pct_bps: 1000 }, sku_scope: 'all',
        identity_tiers: ['T3'], stacking_group: null, status: 'live',
        valid_from: '2026-07-01T00:00:00Z', valid_until: '2026-12-01T00:00:00Z',
      },
      commitment_id: null,
    }));
    const fallback: Decisioner = new PassthroughDecisioner();
    const evil = new HttpDecisioner({
      baseUrl: 'http://sidecar.fake',
      fallback,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ranked: [{ offer_id: newId('off'), score: 1 }, { offer_id: newId('off'), score: 0 }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    const ctx = { agent: { agent_id: null }, tier: 'T3' as const, segment: 't3-acquisition' as const };
    expect(await evil.rank(eligible, ctx)).toEqual(await fallback.rank(eligible, ctx));
  });

  it('quote spend stays honest: the sidecar scores ride RankedOffer.score and NEVER surface in the response', async () => {
    const http = await coreFor(sidecarUrl);
    const agentKey = (await http.agents.register({ name: 'ScoreProbe', contact: 'sp@merited.test' })).api_key;
    const response = await readVia(http, agentKey);
    expect(JSON.stringify(response)).not.toContain('"score"');
  });
});
