import { JsonLdOfferFeed } from '@merited/contracts';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../../trio/scripts/migrate.mjs';
import { createSimulatedCore, type SimulatedCore } from '../../../testing.js';

/**
 * PH3-1 accept — the Phase-3 gate clause: "anonymous JSON-LD reads are
 * untokenised." Registered fetch of the SAME feed returns OfferQuotes with
 * tokens; the anonymous response contains ZERO token material and mints
 * NOTHING (ledger: no TokenMinted rows for anonymous reads). The feed
 * validates against the schema.org/Offer contract shapes.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_feed_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'feed-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let coreUrl = '';
let agentKey = '';

const fetchFeed = async (headers: Record<string, string> = {}, query = '') => {
  const response = await fetch(`${coreUrl}/v1/feed/offers${query}`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/ld+json');
  return (await response.json()) as Record<string, unknown>;
};

const mintedCount = async (): Promise<number> =>
  Number(
    (await pool.query(`SELECT count(*) AS n FROM events.events WHERE type = 'TokenMinted'`)).rows[0]!.n,
  );

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

  const { runSeed } = await import('@merited/seed');
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
  agentKey = (await core.agents.register({ name: 'FeedProbe', contact: 'feed@merited.test' })).api_key;
}, 120_000);

afterAll(async () => {
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH3-1: B11 JSON-LD offer feed', () => {
  it('GATE CLAUSE: an anonymous fetch is UNTOKENISED and mints NOTHING — with the register-to-earn hint', async () => {
    const before = await mintedCount();
    const feed = await fetchFeed();
    expect(await mintedCount()).toBe(before); // ledger assertion: zero mints

    const parsed = JsonLdOfferFeed.parse(feed);
    expect(parsed.itemListElement.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(feed);
    expect(serialised).not.toContain('merited:token');
    expect(serialised).not.toContain('v4.public'); // no token material of any kind
    expect(serialised).not.toContain('merited:quote_id');
    expect(parsed['merited:register_to_earn']).toEqual({ register_url: '/v1/agents/register' });
  });

  it('the SAME feed, registered: OfferQuote tokens ride the merited:* extension fields', async () => {
    const before = await mintedCount();
    const feed = await fetchFeed({ 'x-merited-agent-key': agentKey });
    expect(await mintedCount()).toBeGreaterThan(before); // registered reads MINT (P2)

    const parsed = JsonLdOfferFeed.parse(feed);
    const payable = parsed.itemListElement.filter((e) => e.item['merited:token']);
    expect(payable.length).toBeGreaterThan(0);
    for (const entry of payable) {
      expect(entry.item['merited:quote_id']).toMatch(/^qte_/);
      expect(entry.item['merited:token']).toBeTruthy();
      expect(entry.item['merited:expires_at']).toBeTruthy();
    }
    expect(parsed['merited:register_to_earn']).toBeUndefined();
  });

  it('validates against schema.org/Offer: required fields, decimal prices from integer pence', async () => {
    const feed = JsonLdOfferFeed.parse(await fetchFeed({ 'x-merited-agent-key': agentKey }));
    expect(feed['@context']).toBe('https://schema.org');
    expect(feed['@type']).toBe('ItemList');
    for (const [index, entry] of feed.itemListElement.entries()) {
      expect(entry.position).toBe(index + 1);
      expect(entry.item['@type']).toBe('Offer');
      expect(entry.item.price).toMatch(/^\d+\.\d{2}$/); // decimal string, never a float
      expect(entry.item.priceCurrency).toBe('GBP');
      expect(entry.item.name.length).toBeGreaterThan(0);
      expect(Date.parse(entry.item.availabilityEnds)).toBeGreaterThan(Date.parse(entry.item.availabilityStarts));
      expect(entry.item.seller.identifier).toMatch(/^mer_/);
    }
  });

  it('query filters ride through the canonical path (text ILIKE — same pipeline, same params)', async () => {
    // the T3-payable catalogue is one offer deep, so passthrough is proven
    // by match vs no-match; per-SKU deepening is PH3-9's row
    const matched = JsonLdOfferFeed.parse(
      await fetchFeed({ 'x-merited-agent-key': agentKey }, '?text=spa'),
    );
    expect(matched.itemListElement.length).toBeGreaterThan(0);
    const none = JsonLdOfferFeed.parse(
      await fetchFeed({ 'x-merited-agent-key': agentKey }, '?text=zeppelin'),
    );
    expect(none.itemListElement).toEqual([]);
  });
});
