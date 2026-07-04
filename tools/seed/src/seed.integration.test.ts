import { verifyChain } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../apps/core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
import { AURORA_MERCHANT_ID, AURORA_OFFERS } from './fixtures/aurora.js';
import { runSeed, type SeedResult } from './seed.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_seed_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let result: SeedResult;
const logLines: string[] = [];

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 5 });
  pool.on('error', () => {});
  result = await runSeed({ databaseUrl: appUrl, log: (line) => logLines.push(line) });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('pnpm seed (VAL-9 accept)', () => {
  it('creates Aurora Experiences at its fixed ID with a custodied signing key', async () => {
    expect(result.merchant_id).toBe(AURORA_MERCHANT_ID);
    const { rows } = await pool.query(
      `SELECT name, slug, commercial, signing_key_ref FROM core.merchants WHERE merchant_id = $1`,
      [AURORA_MERCHANT_ID],
    );
    expect(rows[0]).toMatchObject({ name: 'Aurora Experiences', slug: 'aurora-experiences' });
    expect(rows[0].commercial).toMatchObject({ take_rate_bps: 2000, agent_commission_bps: 6000 });
    expect(rows[0].signing_key_ref).toMatch(/^merchant\//);
  });

  it('seeds the static membership table: Member + Gold tiers, sub_hashes present, one revoked', async () => {
    const { rows } = await pool.query(
      `SELECT loyalty_tier, status, sub_hash FROM core.aurora_club_members ORDER BY member_ref`,
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.loyalty_tier))).toEqual(new Set(['Member', 'Gold']));
    expect(rows.filter((r) => r.status === 'revoked')).toHaveLength(1);
    for (const row of rows) expect(row.sub_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('publishes all 6 offers live at their fixed IDs; the spa day holds the COR', async () => {
    const { rows } = await pool.query(
      `SELECT offer_id, status, current_commitment_id FROM core.offers ORDER BY offer_id`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === 'live')).toBe(true);
    expect(new Set(rows.map((r) => r.offer_id))).toEqual(new Set(AURORA_OFFERS.map((f) => f.offer_id)));
    const withCor = rows.filter((r) => r.current_commitment_id !== null);
    expect(withCor).toHaveLength(1);
    expect(withCor[0]!.offer_id).toBe(AURORA_OFFERS.find((f) => f.bounty)!.offer_id);
    expect(withCor[0]!.current_commitment_id).toBe(result.bounty_commitment_id);
  });

  it('publish went through the REAL path: OfferPublished ×6 and ONE CommitmentCreated with §10 step 1 numbers', async () => {
    const { rows: published } = await pool.query(
      `SELECT body->'data'->>'offer_id' AS offer_id FROM events.events WHERE type = 'OfferPublished'`,
    );
    expect(published).toHaveLength(6);
    const { rows: commitments } = await pool.query(
      `SELECT body->'data'->'commitment' AS commitment FROM events.events WHERE type = 'CommitmentCreated'`,
    );
    expect(commitments).toHaveLength(1);
    expect(commitments[0].commitment).toMatchObject({
      commitment_id: result.bounty_commitment_id,
      merchant_id: AURORA_MERCHANT_ID,
      bounty: { type: 'fixed', amount: { amount: 1200, currency: 'GBP_pence' } },
      take_rate_bps: 2000,
      agent_commission_bps: 6000,
    });
    // countersigned by the simulator — both signatures present
    expect(commitments[0].commitment.merchant_sig).toBeTruthy();
    expect(commitments[0].commitment.platform_sig).toBeTruthy();
  });

  it('the seeded ledger passes verify-chain (no back-door inserts anywhere)', async () => {
    const client = await pool.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification).toMatchObject({ ok: true });
      if (verification.ok) expect(verification.count).toBeGreaterThanOrEqual(7);
    } finally {
      client.release();
    }
  });

  it('prints a UK-English summary with pounds formatted from integer pence', () => {
    const summary = logLines.join('\n');
    expect(summary).toContain('£12.00');
    expect(summary).toContain('Aurora Experiences');
  });
});
