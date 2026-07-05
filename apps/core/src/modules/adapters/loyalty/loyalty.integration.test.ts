import type { LoyaltyLookup } from '@merited/contracts';
import { createFakeAuroraLoyalty, type FakeAuroraLoyalty } from '@merited/fake-aurora';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAuroraLoyalty as FakeAuroraLoyaltyAdapter } from './fake-aurora.js';
import { StaticTableLoyalty } from './static-table.js';

/**
 * PH1-11 accept: the adapter contract test runs against BOTH LoyaltyLookup
 * impls — the FakeAurora-API-backed adapter and the static-table adapter.
 * points-credit is idempotent per order ref; the seeded Gold member's
 * balance updates visibly.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_loyalty_${Date.now().toString(36)}`;

// the seeded Gold member (matches AURORA_IDP_MEMBERS + the static seed)
const GOLD = 'am_seed_cyn';
const GOLD_START = 8900;

let admin: pg.Client;
let pool: pg.Pool;
let loyaltyApi: FakeAuroraLoyalty;
let apiUrl: string;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateCore(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  // seed the static table to match the FakeAurora member directory
  await pool.query(
    `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status, points_balance)
     VALUES ($1, 'gold-sub-hash', 'Gold', 'active', $2)`,
    [GOLD, GOLD_START],
  );
  loyaltyApi = await createFakeAuroraLoyalty();
  apiUrl = await loyaltyApi.listen();
});

afterAll(async () => {
  await loyaltyApi.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const impls: Array<{ name: string; make: () => LoyaltyLookup }> = [
  { name: 'FakeAuroraLoyalty (HTTP)', make: () => new FakeAuroraLoyaltyAdapter({ baseUrl: apiUrl }) },
  { name: 'StaticTableLoyalty (DB)', make: () => new StaticTableLoyalty(pool) },
];

for (const { name, make } of impls) {
  describe(`LoyaltyLookup contract — ${name} (PH1-11)`, () => {
    it('member lookup returns tier and balance; unknown → null', async () => {
      const lookup = make();
      const member = await lookup.memberByRef(GOLD);
      expect(member?.tier).toBe('Gold');
      expect(typeof member?.balance).toBe('number');
      expect(await lookup.memberByRef('am_seed_nobody')).toBeNull();
    });

    it('points-credit updates the Gold balance VISIBLY', async () => {
      const lookup = make();
      const before = (await lookup.memberByRef(GOLD))!.balance;
      await lookup.creditPoints({ member_ref: GOLD, points: 100, order_ref_hash: `${name}-order-A` });
      expect((await lookup.memberByRef(GOLD))!.balance).toBe(before + 100);
    });

    it('points-credit is IDEMPOTENT per order ref — a repeat is a no-op', async () => {
      const lookup = make();
      const orderRef = `${name}-order-idem`;
      const before = (await lookup.memberByRef(GOLD))!.balance;
      await lookup.creditPoints({ member_ref: GOLD, points: 250, order_ref_hash: orderRef });
      const afterFirst = (await lookup.memberByRef(GOLD))!.balance;
      expect(afterFirst).toBe(before + 250);
      // same order ref again → balance unchanged
      await lookup.creditPoints({ member_ref: GOLD, points: 250, order_ref_hash: orderRef });
      await lookup.creditPoints({ member_ref: GOLD, points: 250, order_ref_hash: orderRef });
      expect((await lookup.memberByRef(GOLD))!.balance).toBe(afterFirst);
      // a DIFFERENT order ref does credit
      await lookup.creditPoints({ member_ref: GOLD, points: 250, order_ref_hash: `${orderRef}-2` });
      expect((await lookup.memberByRef(GOLD))!.balance).toBe(afterFirst + 250);
    });
  });
}
