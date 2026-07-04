import { COMMITMENT_FIXTURE, FIXTURE_IDS } from '@merited/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import {
  applyConversionCounters,
  conversionEntrySet,
  mandateMonthSpend,
  recordMandateSpend,
  storeEntrySet,
} from './posting.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_post_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  // seed a commitment row + counters for the counter tests
  await pool.query(
    `INSERT INTO trio.commitments (commitment_id, merchant_id, offer_ref, body) VALUES ($1,$2,$3,'{}'::jsonb)`,
    [COMMITMENT_FIXTURE.commitment_id, COMMITMENT_FIXTURE.merchant_id, COMMITMENT_FIXTURE.offer_ref],
  );
  await pool.query(
    `INSERT INTO trio.counters (commitment_id, conversions_used, budget_remaining_pence) VALUES ($1, 0, 600000)`,
    [COMMITMENT_FIXTURE.commitment_id],
  );
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const inTx = async <T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

describe('posting storage (TRIO-9 accept)', () => {
  it('stores a balanced set and emits LedgerEntryPosted into the chain', async () => {
    const set = conversionEntrySet({
      commitment: COMMITMENT_FIXTURE,
      agentId: FIXTURE_IDS.agent,
      claimId: FIXTURE_IDS.claim,
      grossPence: 8450,
    });
    await inTx((tx) => storeEntrySet(tx, set));
    const lines = await pool.query('SELECT count(*) FROM trio.entry_lines WHERE entry_set_id = $1', [
      set.entry_set_id,
    ]);
    expect(Number(lines.rows[0].count)).toBe(4);
    const events = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'LedgerEntryPosted'`,
    );
    expect(Number(events.rows[0].count)).toBe(1);
  });

  it('an unbalanced insert fails AT THE DB (deferred constraint trigger at commit)', async () => {
    await expect(
      inTx(async (tx) => {
        await tx.query(`INSERT INTO trio.entry_sets (entry_set_id, claim_id) VALUES ('set_bad', NULL)`);
        await tx.query(
          `INSERT INTO trio.entry_lines (entry_set_id, account, side, amount_pence)
           VALUES ('set_bad', 'merchant_payable:x', 'dr', 1200), ('set_bad', 'platform_revenue', 'cr', 999)`,
        );
      }),
    ).rejects.toThrow(/does not balance/);
    const { rows } = await pool.query(
      `SELECT count(*) FROM trio.entry_sets WHERE entry_set_id = 'set_bad'`,
    );
    expect(Number(rows[0].count)).toBe(0); // whole transaction rolled back
  });

  it('conversion counters: used +1, budget decremented', async () => {
    await inTx((tx) => applyConversionCounters(tx, COMMITMENT_FIXTURE.commitment_id, 1200));
    const { rows } = await pool.query(
      'SELECT conversions_used, budget_remaining_pence FROM trio.counters WHERE commitment_id = $1',
      [COMMITMENT_FIXTURE.commitment_id],
    );
    expect(rows[0].conversions_used).toBe(1);
    expect(Number(rows[0].budget_remaining_pence)).toBe(598800);
  });

  it('mandate month spend accumulates per (mandate, month)', async () => {
    await inTx((tx) => recordMandateSpend(tx, FIXTURE_IDS.mandate, '2026-07', 8450));
    await inTx((tx) => recordMandateSpend(tx, FIXTURE_IDS.mandate, '2026-07', 1000));
    const client = await pool.connect();
    try {
      expect(await mandateMonthSpend(client, FIXTURE_IDS.mandate, '2026-07')).toBe(9450);
      expect(await mandateMonthSpend(client, FIXTURE_IDS.mandate, '2026-08')).toBe(0);
    } finally {
      client.release();
    }
  });
});
