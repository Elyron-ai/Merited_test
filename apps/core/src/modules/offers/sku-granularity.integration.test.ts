import { JsonLdOfferFeed, pence, type MerchantCommercial } from '@merited/contracts';
import { CATALOGUE } from '@merited/fake-aurora';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
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
import { createSimulatedCore, type SimulatedCore } from '../../testing.js';

/**
 * PH3-9 accept, end-to-end: "Offer scoped to SKUs quotes only for matching
 * SKU queries; sku_scope 'all' behaviour unchanged; bundle sku_refs resolve
 * against FakeShop's seeded SKUs." Three offers — scoped, open, bundle —
 * read over HTTP with ?sku=, plus the per-SKU JSON-LD rendering (PH3-1's
 * feed deepened).
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_sku_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'sku-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let coreUrl = '';
let agentKey = '';
let scopedId = '';
let openId = '';
let bundleId = '';

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const BUNDLE_SKU_REFS = ['sku_spa_day', 'sku_lunch'];

const readQuotes = async (query: string): Promise<Array<{ offer_id: string; token: string | null }>> => {
  const response = await fetch(`${coreUrl}/v1/offers${query}`, {
    headers: { 'x-merited-agent-key': agentKey },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { quotes: Array<{ offer_id: string; token: string | null }> }).quotes;
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  const merchant = await core.merchants.create({ name: 'Aurora Experiences', commercial });
  await core.merchants.requestSigningKey(merchant.merchant_id);

  const draft = (overrides: Record<string, unknown>) =>
    core.offers.createDraft({
      merchant_id: merchant.merchant_id,
      title: 'Offer',
      description: 'Offer',
      mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
      identity_tiers: ['T1', 'T2', 'T3'],
      stacking_group: null,
      valid_from: iso(-3600),
      valid_until: iso(180 * 86400),
      sku_scope: 'all',
      ...overrides,
    });

  const scoped = await draft({ title: 'Spa only', sku_scope: ['sku_spa_day'] });
  const open = await draft({ title: 'Everything', sku_scope: 'all' });
  const bundle = await draft({
    title: 'Spa + lunch bundle',
    sku_scope: BUNDLE_SKU_REFS,
    mechanics: { type: 'bundle', sku_refs: BUNDLE_SKU_REFS, value: pence(9900) },
  });
  scopedId = scoped.offer_id;
  openId = open.offer_id;
  bundleId = bundle.offer_id;
  for (const offer of [scoped, open, bundle]) {
    await core.publisher.publish(offer.offer_id, { bounty: { type: 'fixed', amount: pence(500) } });
  }

  agentKey = (await core.agents.register({ name: 'SkuProbe', contact: 'sku@merited.test' })).api_key;
}, 120_000);

afterAll(async () => {
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('SKU-level granularity end-to-end (PH3-9 accept)', () => {
  it('ACCEPT: a scoped offer quotes ONLY for matching SKU queries — deterministically', async () => {
    const matching = await readQuotes('?sku=sku_spa_day');
    expect(new Set(matching.map((q) => q.offer_id))).toEqual(new Set([scopedId, openId, bundleId]));
    for (const quote of matching) expect(quote.token).not.toBeNull();

    const missing = await readQuotes('?sku=sku_massage');
    expect(new Set(missing.map((q) => q.offer_id))).toEqual(new Set([openId]));

    // determinism: the same query twice returns the same offer set
    const again = await readQuotes('?sku=sku_massage');
    expect(new Set(again.map((q) => q.offer_id))).toEqual(new Set([openId]));
  });

  it("REGRESSION: sku_scope 'all' behaviour unchanged — quoted with and without ?sku=", async () => {
    const unfiltered = await readQuotes('');
    expect(new Set(unfiltered.map((q) => q.offer_id))).toEqual(
      new Set([scopedId, openId, bundleId]),
    );
  });

  it('ACCEPT: bundle sku_refs RESOLVE — a bundled SKU surfaces the bundle, and every ref is a real FakeShop SKU', async () => {
    // asking for the lunch SKU: the scoped spa offer does NOT match; the
    // bundle does (sku_lunch is one of its sku_refs), the open offer always
    const viaLunch = await readQuotes('?sku=sku_lunch');
    expect(new Set(viaLunch.map((q) => q.offer_id))).toEqual(new Set([openId, bundleId]));

    // resolution against the SEEDED catalogue: every bundle ref exists
    const catalogueSkus = new Set(CATALOGUE.map((entry) => entry.sku));
    for (const ref of BUNDLE_SKU_REFS) {
      expect(catalogueSkus.has(ref)).toBe(true);
    }
  });

  it('per-SKU JSON-LD: list-scoped offers render one entry per SKU carrying the sku field', async () => {
    const response = await fetch(`${coreUrl}/v1/feed/offers?sku=sku_lunch`, {
      headers: { 'x-merited-agent-key': agentKey },
    });
    expect(response.status).toBe(200);
    const feed = JsonLdOfferFeed.parse(await response.json());

    const bundleEntries = feed.itemListElement.filter((e) => e.item.identifier === bundleId);
    expect(bundleEntries.map((e) => e.item.sku).sort()).toEqual([...BUNDLE_SKU_REFS].sort());

    const openEntries = feed.itemListElement.filter((e) => e.item.identifier === openId);
    expect(openEntries).toHaveLength(1);
    expect(openEntries[0]!.item.sku).toBeUndefined(); // 'all' keeps its single entry

    // positions stay a clean 1..n sequence after the per-SKU expansion
    expect(feed.itemListElement.map((e) => e.position)).toEqual(
      feed.itemListElement.map((_, i) => i + 1),
    );
  });
});
