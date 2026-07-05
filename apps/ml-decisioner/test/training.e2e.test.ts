import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyticsProjection } from '@merited/core';
import { catchUp, rebuildProjection } from '@merited/events';
import { auditExhaust, generateTraffic } from '@merited/seed/traffic';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';

/**
 * PH2-8 accept: "Training runs end-to-end from a rebuilt projection schema
 * (analytics:rebuild → train) — proves the 'trained on ledger exhaust'
 * claim structurally; no feature reads from anything but read models."
 * LEAD-4 rides along: the deterministic synthetic-traffic generator writes
 * EVENTS (never projection rows) and the adequacy audit flips to adequate.
 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_ml8_${Date.now().toString(36)}`;

const B19_TABLES = [
  'core.mint_vs_claim_by_merchant_day',
  'core.budget_burn',
  'core.rejections_by_reason_day',
  'core.conversions_by_agent_day',
];

let admin: pg.Client;
let pool: pg.Pool;
let appUrl = '';
let modelDir = '';

const train = (): string => {
  try {
    return execSync('python3 training/train.py', {
      cwd: appRoot,
      env: { ...process.env, MERITED_DATABASE_URL: appUrl, MERITED_MODEL_DIR: modelDir },
      encoding: 'utf-8',
      timeout: 180_000,
    }).trim();
  } catch (error) {
    throw new Error(`train.py failed: ${(error as { stderr?: string }).stderr ?? String(error)}`);
  }
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});
  modelDir = mkdtempSync(path.join(os.tmpdir(), 'merited-ml8-'));
}, 60_000);

afterAll(async () => {
  rmSync(modelDir, { recursive: true, force: true });
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-8 + LEAD-4: ledger-exhaust training pipeline', () => {
  it('STRUCTURAL: train.py reads ONLY the four B19 read models', () => {
    const source = readFileSync(path.join(appRoot, 'training', 'train.py'), 'utf-8');
    const tables = new Set(source.match(/(?:FROM|JOIN)\s+(core\.[a-z_]+)/gi)?.map((m) => m.split(/\s+/)[1]!) ?? []);
    expect(tables.size).toBeGreaterThan(0);
    for (const table of tables) {
      expect(B19_TABLES, `${table} is not a B19 read model`).toContain(table);
    }
    expect(source).not.toMatch(/events\.events|wallet\.|trio\.|core\.offers|core\.quotes|core\.merchants/);
  });

  it('LEAD-4: exhaust starts THIN; the deterministic generator makes it adequate — via EVENTS only', async () => {
    await catchUp(pool, analyticsProjection);
    expect((await auditExhaust(pool)).verdict).toBe('thin');

    const report = await generateTraffic(pool, { seed: 7, merchants: 8, days: 30, mintsPerDay: 6, baseDate: '2026-07-01' });
    expect(report.events).toBeGreaterThan(1000);
    await catchUp(pool, analyticsProjection);
    const audit = await auditExhaust(pool);
    expect(audit.verdict).toBe('adequate');
    expect(audit.merchantDays).toBeGreaterThanOrEqual(200);
  }, 240_000);

  it('ACCEPT: rebuild → train runs end-to-end; the artefact is versioned, feature-complete and REPRODUCIBLE', async () => {
    // the accept's literal path: a WIPED, rebuilt projection schema first
    const replayed = await rebuildProjection(pool, analyticsProjection);
    expect(replayed).toBeGreaterThan(1000);

    const version = train();
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    const artefact = JSON.parse(readFileSync(path.join(modelDir, 'latest.json'), 'utf-8')) as {
      version: string;
      backend: string;
      trained_from: string;
      feature_names: string[];
      rows: number;
      positives: number;
    };
    expect(artefact.version).toBe(version);
    expect(artefact.trained_from).toBe('b19-read-models');
    expect(['lightgbm', 'logistic']).toContain(artefact.backend);
    expect(artefact.feature_names).toContain('claim_rate_bps');
    expect(artefact.rows).toBeGreaterThanOrEqual(200);
    expect(artefact.positives).toBeGreaterThan(0);
    expect(artefact.positives).toBeLessThan(artefact.rows); // both classes present

    // reproducibility: wipe + rebuild + retrain converges on the SAME version
    await rebuildProjection(pool, analyticsProjection);
    expect(train()).toBe(version);
  }, 300_000);
});
