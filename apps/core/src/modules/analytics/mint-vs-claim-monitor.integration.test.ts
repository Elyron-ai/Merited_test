import { newId, pence, type Commitment } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import { MintVsClaimMonitor } from './mint-vs-claim-monitor.js';

/**
 * PH1-20 accept (synthetic): mint N tokens, claim < floor% → the alert fires
 * within ONE projection cycle; a healthy merchant → no alert. Plus: the
 * trailing window excludes old traffic; sparse traffic is insufficient_data
 * (never alerted); the badge read model rows land for the control-plane; the
 * monitor runs continuously via start().
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_b20_${Date.now().toString(36)}`;

const HEALTHY = 'mer_0000000000000000000000B20A' as const;
const SILENT = 'mer_0000000000000000000000B20B' as const; // the under-reporter
const SPARSE = 'mer_0000000000000000000000B20C' as const;
const CID_H = 'com_0000000000000000000000B20D' as const;
const CID_S = 'com_0000000000000000000000B20E' as const;
const CID_P = 'com_0000000000000000000000B20F' as const;

// frozen clock: evaluation happens "now"; events land on recent days
const NOW = new Date('2026-07-05T12:00:00Z');
const dayOffset = (days: number): string =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let alerts: Array<Record<string, unknown>>;
let monitor: MintVsClaimMonitor;

const commitmentFor = (cid: `com_${string}`, merchant: `mer_${string}`): Commitment => ({
  commitment_id: cid,
  merchant_id: merchant,
  offer_ref: 'off_0000000000000000000000B20X',
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: '2026-01-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
  merchant_sig: 'fake-ed25519:m',
  platform_sig: 'fake-ed25519:p',
});

const mintOn = async (cid: `com_${string}`, daysAgo: number): Promise<void> => {
  await appendEventInNewTx(pool, 'TokenMinted', {
    claims: {
      jti: newId('atk'), cid, qid: newId('qte'), aid: 'agt_0000000000000000000000B20Y',
      tier: 'T3' as const, sid: 'a'.repeat(64), apr: null,
      iat: Math.floor((NOW.getTime() - daysAgo * 86_400_000) / 1000),
      exp: Math.floor((NOW.getTime() - daysAgo * 86_400_000) / 1000) + 600,
    },
  });
};

const claimOn = async (cid: `com_${string}`, merchant: `mer_${string}`, daysAgo: number): Promise<void> => {
  await appendEventInNewTx(pool, 'ConversionClaimed', {
    claim_id: newId('clm'), merchant_id: merchant, jti: newId('atk'), qid: newId('qte'), cid,
    order_ref_hash: 'd'.repeat(64), gross_value: pence(8450), ts: dayOffset(daysAgo),
  });
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});

  await appendEventInNewTx(pool, 'CommitmentCreated', { commitment: commitmentFor(CID_H, HEALTHY) });
  await appendEventInNewTx(pool, 'CommitmentCreated', { commitment: commitmentFor(CID_S, SILENT) });
  await appendEventInNewTx(pool, 'CommitmentCreated', { commitment: commitmentFor(CID_P, SPARSE) });

  // HEALTHY: 12 mints, 8 claims in-window (66% ≥ 25% floor)
  for (let i = 0; i < 12; i += 1) await mintOn(CID_H, 1 + (i % 3));
  for (let i = 0; i < 8; i += 1) await claimOn(CID_H, HEALTHY, 1 + (i % 3));
  // SILENT: 20 mints in-window, ONE claim (5% < 25% floor) — the drill
  for (let i = 0; i < 20; i += 1) await mintOn(CID_S, 1 + (i % 4));
  await claimOn(CID_S, SILENT, 2);
  // SILENT also has a big HEALTHY burst outside the window (must not rescue it)
  for (let i = 0; i < 30; i += 1) await mintOn(CID_S, 20);
  for (let i = 0; i < 30; i += 1) await claimOn(CID_S, SILENT, 20);
  // SPARSE: 3 mints, 0 claims — insufficient data, never alerted
  for (let i = 0; i < 3; i += 1) await mintOn(CID_P, 1);

  alerts = [];
  monitor = new MintVsClaimMonitor({
    pool,
    clock: { now: () => NOW },
    logger: {
      warn: (payload) => alerts.push(payload),
      info: () => {},
    },
    options: { floorBps: 2500, windowDays: 7, minMints: 10 },
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('mint-vs-claim monitor (PH1-20)', () => {
  it('ACCEPT: claim rate below the floor → alert fires within ONE cycle; healthy merchant → NO alert', async () => {
    const results = await monitor.runOnce(); // one cycle: catch-up + evaluate

    const silent = results.find((r) => r.merchant_id === SILENT)!;
    expect(silent.status).toBe('under_reporting');
    expect(silent.mints).toBe(20); // the out-of-window burst did NOT count
    expect(silent.claims).toBe(1);
    expect(silent.claim_rate_bps).toBe(500); // 5%

    const healthy = results.find((r) => r.merchant_id === HEALTHY)!;
    expect(healthy.status).toBe('healthy');

    // exactly ONE alert, for the silent merchant, carrying the full context
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert: 'mint_vs_claim_under_reporting',
      merchant_id: SILENT,
      claim_rate_bps: 500,
      floor_bps: 2500,
      window_days: 7,
      mints: 20,
      claims: 1,
    });
  });

  it('sparse traffic is insufficient_data — flagged for the badge, never alerted', async () => {
    alerts.length = 0;
    const results = await monitor.runOnce();
    const sparse = results.find((r) => r.merchant_id === SPARSE)!;
    expect(sparse.status).toBe('insufficient_data');
    expect(alerts.every((a) => a['merchant_id'] !== SPARSE)).toBe(true);
  });

  it('the badge read model lands in core.merchant_health for the control-plane', async () => {
    const { rows } = await pool.query<{ merchant_id: string; status: string; claim_rate_bps: number | null }>(
      `SELECT merchant_id, status, claim_rate_bps FROM core.merchant_health ORDER BY merchant_id`,
    );
    expect(rows).toEqual([
      { merchant_id: HEALTHY, status: 'healthy', claim_rate_bps: 6666 },
      { merchant_id: SILENT, status: 'under_reporting', claim_rate_bps: 500 },
      { merchant_id: SPARSE, status: 'insufficient_data', claim_rate_bps: 0 },
    ]);
  });

  it('a recovery flips the badge back on the very next cycle (no sticky alerts)', async () => {
    // the silent merchant starts claiming again — 9 more claims in-window
    for (let i = 0; i < 9; i += 1) await claimOn(CID_S, SILENT, 0);
    alerts.length = 0;
    const results = await monitor.runOnce();
    const recovered = results.find((r) => r.merchant_id === SILENT)!;
    expect(recovered.status).toBe('healthy'); // 10/20 = 50% ≥ 25%
    expect(alerts).toHaveLength(0);
  });

  it('start() runs the monitor continuously and stop() halts it', async () => {
    const before = (await pool.query<{ evaluated_at: Date }>(
      `SELECT evaluated_at FROM core.merchant_health WHERE merchant_id = $1`, [HEALTHY],
    )).rows[0]!.evaluated_at;

    const handle = monitor.start(40); // fast ticks for the test
    await new Promise((resolve) => setTimeout(resolve, 150));
    handle.stop();

    const after = (await pool.query<{ evaluated_at: Date }>(
      `SELECT evaluated_at FROM core.merchant_health WHERE merchant_id = $1`, [HEALTHY],
    )).rows[0]!.evaluated_at;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime()); // cycles ran
    // and after stop(), no further cycles
    const frozen = after;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const later = (await pool.query<{ evaluated_at: Date }>(
      `SELECT evaluated_at FROM core.merchant_health WHERE merchant_id = $1`, [HEALTHY],
    )).rows[0]!.evaluated_at;
    expect(later.getTime()).toBe(frozen.getTime());
  });
});
