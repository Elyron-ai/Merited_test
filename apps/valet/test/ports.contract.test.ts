import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeShop } from '@merited/fake-aurora';
import { MeritedClient } from '@merited/sdk';
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
// the seed by source path (the CORE-14 pattern — no package edge, no cycle)
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';
import { AutoSkipGate } from '../src/ports/approval-gate.js';
import { FakeShopRail } from '../src/ports/checkout-rail.js';
import { PostgresCredentialsStore } from '../src/ports/credentials.js';
import { QuoteClient } from '../src/ports/quote-client.js';
import { VerdictPoller, VerdictTimeoutError } from '../src/ports/verdict-poller.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_ports_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'ports-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let coreUrl: string;
let shopUrl: string;
let client: QuoteClient;
let rail: FakeShopRail;

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;
const noSleep = () => Promise.resolve();

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

  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  const merchant = (await core.merchants.list())[0]!;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  client = new QuoteClient({
    baseUrl: coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet',
    contact: 'valet@example.test',
  });
  rail = new FakeShopRail(shopUrl);
});

afterAll(async () => {
  await shop.close();
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('platform client ports (VAL-5 accept — contract tests vs a locally-run Core + FakeShop)', () => {
  it('QuoteClient registers ONCE and persists agt_ + api key; a fresh instance reuses them', async () => {
    const first = await client.ensureRegistered();
    expect(first.agent_id).toMatch(/^agt_/);
    expect(first.api_key).toMatch(/^mak_/);

    const rebooted = new QuoteClient({ baseUrl: coreUrl, store: new PostgresCredentialsStore(pool) });
    const second = await rebooted.ensureRegistered();
    expect(second).toEqual(first); // same identity, no re-registration
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM core.agents`);
    expect(rows[0].n).toBe(1);
  });

  it('registered read returns a quote-bound TOKEN (§5.2, client side)', async () => {
    const read = await client.readOffers({ text: 'spa', sub_hash: gold.sub_hash });
    const payable = read.quotes.find((q) => q.token !== null);
    expect(payable).toBeDefined();
    expect(read.hint).toBeUndefined(); // registered reads carry no hint
    expect((await client.getQuote(payable!.quote_id)).status).toBe('live');
  });

  it('unregistered read returns token: null + register_to_earn (§5.2, client side)', async () => {
    const anonymous = new MeritedClient({ baseUrl: coreUrl });
    const read = await anonymous.readOffers({ text: 'spa' });
    expect(read.quotes.length).toBeGreaterThanOrEqual(1);
    expect(read.quotes.every((q) => q.token === null)).toBe(true);
    expect(read.hint).toMatchObject({ register_to_earn: true });
  });

  it('FakeShopRail: checkout carries the token; a resumed errand REPLAYS the same order (§8, never double-buys)', async () => {
    const read = await client.readOffers({ text: 'spa', sub_hash: gold.sub_hash });
    const quote = read.quotes.find((q) => q.token !== null)!;
    const errandId = newId('ern');

    const confirmation = await rail.checkout({
      sku: 'sku_spa_day',
      attribution_token: quote.token,
      errand_id: errandId,
    });
    expect(confirmation.webhook).toBe('delivered');
    expect(confirmation.total_pence).toBe(8450);

    // the resume path: same errand id → byte-same confirmation, ONE order
    const resumed = await rail.checkout({
      sku: 'sku_spa_day',
      attribution_token: quote.token,
      errand_id: errandId,
    });
    expect(resumed).toEqual(confirmation);
    const intake = await pool.query(`SELECT count(*)::int AS n FROM core.claims_intake`);
    expect(intake.rows[0].n).toBe(1); // one webhook → one claim

    // VerdictPoller finds the verdict through the agent's own quote (SYN-40)
    const poller = new VerdictPoller({ client, sleep: noSleep });
    const verdict = await poller.poll(quote.quote_id);
    expect(verdict.type).toBe('CLAIM_VERIFIED');
  });

  it('VerdictPoller surfaces a REJECTED replay and times out politely on silent quotes', async () => {
    // replaying the consumed token through a NEW errand → TOKEN_REPLAYED
    const read = await client.readOffers({ text: 'spa', sub_hash: gold.sub_hash });
    const fresh = read.quotes.find((q) => q.token !== null)!;
    // consume it
    await rail.checkout({ sku: 'sku_spa_day', attribution_token: fresh.token, errand_id: newId('ern') });
    const poller = new VerdictPoller({ client, sleep: noSleep });
    expect((await poller.poll(fresh.quote_id)).type).toBe('CLAIM_VERIFIED');
    // replay the SAME token — the adapter submits, the trio rejects
    await rail.checkout({ sku: 'sku_spa_day', attribution_token: fresh.token, errand_id: newId('ern') });
    const replayVerdict = await poller.poll(fresh.quote_id);
    expect(replayVerdict).toEqual({ type: 'CLAIM_REJECTED', reason_code: 'TOKEN_REPLAYED' });

    // a quote nobody claims: capped attempts, then a driver-mappable timeout
    const silent = await client.readOffers({ text: 'spa', sub_hash: gold.sub_hash });
    const unclaimed = silent.quotes.find((q) => q.token !== null)!;
    const impatient = new VerdictPoller({ client, maxAttempts: 3, sleep: noSleep });
    await expect(impatient.poll(unclaimed.quote_id)).rejects.toThrow(VerdictTimeoutError);
  });

  it('quote-claim discovery is OWNER-ONLY: another registered agent gets a uniform 401', async () => {
    const read = await client.readOffers({ text: 'spa', sub_hash: gold.sub_hash });
    const mine = read.quotes.find((q) => q.token !== null)!;
    const stranger = new MeritedClient({ baseUrl: coreUrl });
    await stranger.register({ name: 'Stranger', contact: 'other@example.test' });
    await expect(stranger.getQuoteClaim(mine.quote_id)).rejects.toMatchObject({ status: 401 });
  });

  it('AutoSkipGate records the walletless skip (D4)', async () => {
    const outcome = await new AutoSkipGate().consult();
    expect(outcome).toEqual({ type: 'APPROVAL_SKIPPED', reason: 'walletless' });
  });

  it('the lint fence fails the build on an apps/core import from valet production code', () => {
    const valetSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const repoRoot = path.resolve(valetSrc, '..', '..', '..');
    const fixtureDir = mkdtempSync(path.join(valetSrc, 'fence-fixture-'));
    const fixture = path.join(fixtureDir, 'illegal.ts');
    writeFileSync(fixture, `import { createSimulatedCore } from '@merited/core/testing';\nexport const x = createSimulatedCore;\n`);
    try {
      let failed = false;
      try {
        execSync(`pnpm exec eslint --no-warn-ignored ${JSON.stringify(fixture)}`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (error) {
        failed = true;
        const output = String((error as { stdout?: Buffer }).stdout ?? '');
        expect(output).toContain('fenced to @merited/{contracts,sdk,events}');
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
