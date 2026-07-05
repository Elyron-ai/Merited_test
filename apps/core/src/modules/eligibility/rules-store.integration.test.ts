import { seededIdFactory } from '@merited/contracts/testing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RulesStore } from './exclusions.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_rules_${Date.now().toString(36)}`;
const ids = seededIdFactory(3055);
const merchantId = ids.next('mer');

let admin: pg.Client;
let pool: pg.Pool;
let store: RulesStore;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 3,
  });
  pool.on('error', () => {});
  await pool.query(
    `INSERT INTO core.merchants (merchant_id, name, slug, commercial) VALUES ($1, 'Fixture', 'fixture', $2::jsonb)`,
    [
      merchantId,
      JSON.stringify({
        take_rate_bps: 2000,
        agent_commission_bps: 6000,
        attribution_window_s: 86400,
        clawback_window_s: 2592000,
        budgets: { per_offer_default: null },
      }),
    ],
  );
  store = new RulesStore(pool);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('RulesStore (PH1-3 — core.eligibility_rules)', () => {
  it('add → list → remove round-trips through the contract union', async () => {
    const rule = await store.add({
      type: 'merchant_sku_exclusion',
      merchant_id: merchantId,
      sku_ref: 'sku_spa_day',
      note: 'not for agent distribution',
    });
    expect(rule.rule_id.startsWith('elr_')).toBe(true);
    const listed = await store.list(merchantId);
    expect(listed).toEqual([rule]);
    expect(await store.list()).toEqual([rule]); // unfiltered list too
    expect(await store.remove(rule.rule_id)).toBe(true);
    expect(await store.remove(rule.rule_id)).toBe(false); // idempotent delete
    expect(await store.list(merchantId)).toEqual([]);
  });

  it('malformed rule bodies are refused at the door, never stored', async () => {
    await expect(
      store.add({
        type: 'merchant_agent_exclusion',
        merchant_id: merchantId,
        agent_id: 'not-an-agent-id',
        note: null,
      } as never),
    ).rejects.toThrow();
    expect(await store.list(merchantId)).toEqual([]);
  });
});
