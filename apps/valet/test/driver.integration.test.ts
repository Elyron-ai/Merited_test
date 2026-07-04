import { newId, pence } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
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
import { ErrandDriver } from '../src/errand/driver.js';
import { EventsPackageMirror } from '../src/errand/ledger-mirror.js';
import { ErrandStore } from '../src/errand/store.js';
import { AutoSkipGate } from '../src/ports/approval-gate.js';
import { FakeShopRail, shopCatalogueSkuResolver } from '../src/ports/checkout-rail.js';
import { PostgresCredentialsStore } from '../src/ports/credentials.js';
import { QuoteClient } from '../src/ports/quote-client.js';
import { VerdictPoller } from '../src/ports/verdict-poller.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_driver_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'driver-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let valetPool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let shopUrl: string;
let driver: ErrandDriver;
let quotes: QuoteClient;
let rail: FakeShopRail;

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

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
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  valetPool = new pg.Pool({
    connectionString: `postgres://merited_valet:merited_valet_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  valetPool.on('error', () => {});

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
  shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  quotes = new QuoteClient({
    baseUrl: coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet',
    contact: 'valet@example.test',
  });
  rail = new FakeShopRail(shopUrl);
  driver = new ErrandDriver({
    store: new ErrandStore(pool),
    mirror: new EventsPackageMirror(valetPool),
    quotes,
    rail,
    gate: new AutoSkipGate(),
    poller: new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }),
    resolveSku: shopCatalogueSkuResolver(shopUrl),
  });
});

afterAll(async () => {
  await shop.close();
  await core.close();
  await trio.close();
  await valetPool.end();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('errand driver (VAL-6 accept — integration vs sims + FakeShop)', () => {
  it('one brief runs BRIEFED → … → CONFIRMED; the ledger holds the mirrored trail from QUOTED onward', async () => {
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
    });
    expect(started.state).toBe('BRIEFED');

    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('CONFIRMED');
    expect(finished.errand.quote_id).toMatch(/^qte_/);
    expect(finished.errand.token).toMatch(/^v4\.public\.fake\./);
    expect(finished.errand.claim_id).toMatch(/^clm_/);
    expect(finished.errand.approval_id).toBeNull(); // D4 skip: no wallet approval

    // the mirrored trail: QUOTED onward, nothing for BRIEFED/SEARCHING
    const { rows } = await pool.query(
      `SELECT body->'data'->>'to' AS to_state FROM events.events
        WHERE type = 'ErrandStateChanged' AND body->'data'->>'errand_id' = $1 ORDER BY seq`,
      [started.errand.errand_id],
    );
    expect(rows.map((r) => r.to_state)).toEqual(['QUOTED', 'APPROVED', 'EXECUTING', 'CONFIRMED']);
  });

  it('a CLAIM_REJECTED path lands FAILED and stays parked (no auto-retry of a consumed token)', async () => {
    const started = await driver.startErrand({
      brief: { text: 'spa day please', max_price: pence(12000), sub_hash: gold.sub_hash },
    });
    const id = started.errand.errand_id;

    // step to QUOTED so the errand's token exists and is persisted
    expect((await driver.step(id))!.state).toBe('SEARCHING');
    const quoted = (await driver.step(id))!;
    expect(quoted.state).toBe('QUOTED');

    // an interloper spends the SAME token first (different errand id)
    const theft = await rail.checkout({
      sku: 'sku_spa_day',
      attribution_token: quoted.errand.token,
      errand_id: newId('ern'),
    });
    expect(theft.webhook).toBe('delivered');

    // the errand proceeds: skip → execute → its own checkout REPLAYS the
    // consumed token → the trio rejects → CLAIM_REJECTED → FAILED
    expect((await driver.step(id))!.state).toBe('APPROVED');
    expect((await driver.step(id))!.state).toBe('EXECUTING');
    const failed = (await driver.step(id))!;
    expect(failed.state).toBe('FAILED');

    // parked: drive() does nothing further — a consumed token must never auto-retry
    expect((await driver.drive(id)).state).toBe('FAILED');
    expect(await driver.step(id)).toBeNull();

    // the rejection is in the mirrored trail
    const { rows } = await pool.query(
      `SELECT body->'data'->>'to' AS to_state FROM events.events
        WHERE type = 'ErrandStateChanged' AND body->'data'->>'errand_id' = $1 ORDER BY seq`,
      [id],
    );
    expect(rows.map((r) => r.to_state)).toEqual(['QUOTED', 'APPROVED', 'EXECUTING', 'FAILED']);
  });

  it('resumeAll rehydrates open errands and re-enters side effects idempotently (FAILED stays parked)', async () => {
    const store = new ErrandStore(pool);
    const open = await store.loadOpenErrands();
    // the FAILED errand from the previous test is open but must stay put
    expect(open.some((s) => s.state === 'FAILED')).toBe(true);
    const results = await driver.resumeAll();
    for (const result of results) {
      expect(['FAILED']).toContain(result.state); // nothing regressed, nothing re-bought
    }
    const intake = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    const after = await driver.resumeAll();
    const intakeAfter = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    expect(intakeAfter.rows[0].n).toBe(intake.rows[0].n); // no double-buys on resume
    expect(after.length).toBe(results.length);
  });
});
