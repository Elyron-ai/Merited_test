import { pence } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
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
import { AcpCheckoutRail } from '../src/ports/acp-rail.js';
import { PostgresCredentialsStore } from '../src/ports/credentials.js';
import { QuoteClient } from '../src/ports/quote-client.js';
import { VerdictPoller } from '../src/ports/verdict-poller.js';

/**
 * PH3-4 accept, Valet leg: "Valet EXECUTING can complete an errand over the
 * ACP rail in the test harness." No FakeShop anywhere: the purchase leaves
 * over ACP and the attribution callback arrives at core's ACP intake,
 * signed like any inbound delivery.
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_acprail_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'acp-rail-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let valetPool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let driver: ErrandDriver;

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

  const quotes = new QuoteClient({
    baseUrl: coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet (ACP)',
    contact: 'valet@example.test',
  });
  driver = new ErrandDriver({
    store: new ErrandStore(pool),
    mirror: new EventsPackageMirror(valetPool),
    quotes,
    rail: new AcpCheckoutRail({
      coreBaseUrl: coreUrl,
      merchantSlug: merchant.slug,
      webhookSecret,
      priceFor: () => 8450, // the platform's price book — integer pence
    }),
    gate: new AutoSkipGate(),
    poller: new VerdictPoller({ client: quotes, sleep: () => Promise.resolve() }),
    resolveSku: async () => 'sku_spa_day', // no shop catalogue on the ACP rail
  });
});

afterAll(async () => {
  await core.close();
  await trio.close();
  await valetPool.end();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('errand over the ACP rail (PH3-4 accept)', () => {
  it('BRIEFED → … → CONFIRMED over ACP: token minted at quote, claim verified via the ACP callback', async () => {
    const started = await driver.startErrand({
      brief: { text: 'spa day under £120', max_price: pence(12000), sub_hash: gold.sub_hash },
    });
    const finished = await driver.drive(started.errand.errand_id);
    expect(finished.state).toBe('CONFIRMED');
    expect(finished.errand.token).toMatch(/^v4\.public\.fake\./);
    expect(finished.errand.claim_id).toMatch(/^clm_/);

    // the verified claim in core carries the errand's OWN quote id — the
    // original qid survived the protocol hop intact (accept clause)
    const intake = await pool.query(
      `SELECT verdict, qid FROM core.claims_intake WHERE claim_id = $1`,
      [finished.errand.claim_id],
    );
    expect(intake.rows[0]).toEqual({ verdict: 'verified', qid: finished.errand.quote_id });
  });
});
