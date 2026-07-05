import { createHash } from 'node:crypto';
import { newId, pence, type MerchantCommercial, type Offer } from '@merited/contracts';
import { FakeCrypter } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../../wallet/scripts/migrate.mjs';
import { NoopGuardrails } from '../guardrails/index.js';
import { PassthroughDecisioner } from '../decisioning/index.js';
import { IdentityStore } from './store.js';
import { PgIdentityLinkReader } from './link-reader.js';
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { QuoteService } from '../quotes/service.js';
import { TrioTokenClient } from '../token-client/client.js';
import { OfferPublisher } from '../offers/publisher.js';
import { ReadOffers } from '../offers/read-offers.js';
import { OffersRepository } from '../offers/repository.js';
import { OffersService } from '../offers/service.js';
import { TrioCommitmentsClient } from '../offers/trio-commitments-client.js';

/**
 * PH1-15 gate proof — "walletless-T1 via `sub_hash` proven" (§6.3 accept). A
 * plain SDK agent with NO wallet session presents the `sub_hash` of a real B23
 * IdentityLink and receives a T1 member-priced quote, including the T1-gated
 * offer, through the ordinary readOffers pipeline. Revoking the link downgrades
 * the very next quote to T3 (live check, no cache window).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_wtless_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'walletless-t1-test';
const agentId = newId('agt');
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

// a real Aurora member (Member tier), linked via B23
const PROGRAMME = 'aurora-club';
const ADA = 'am_seed_ada';
const ADA_LINK_SUBHASH = sha256hex(ADA); // what the agent presents (link derivation)
const ADA_MEMBER_REF = `mbr_${sha256hex(`${PROGRAMME}:${ADA}`).slice(0, 24)}`;
const ADA_SEED_SUBHASH = sha256hex(`${PROGRAMME}:${ADA}`); // seeded tier fallback

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let readOffers: ReadOffers;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateWallet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: 'trio-test-secret' });
  const trioUrl = await trio.listen();

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('walletless-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const commitmentsClient = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: commitmentsClient,
    merchantFor: (id) => merchants.get(id),
  });

  const merchant = await merchants.create({ name: 'Aurora Experiences', commercial });
  const mkOffer = (
    title: string,
    overrides: Partial<Omit<Offer, 'offer_id' | 'status'>> = {},
  ): Omit<Offer, 'offer_id' | 'status'> => ({
    merchant_id: merchant.merchant_id,
    title,
    description: `${title} at Aurora`,
    mechanics: { type: 'percentage_off', pct_bps: 1500 },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
    ...overrides,
  });
  const spa = await offers.createDraft(mkOffer('Spa day', { sku_scope: ['sku_spa_day'] }));
  await publisher.publish(spa.offer_id, { bounty: { type: 'fixed', amount: pence(1200) } });
  const lunch = await offers.createDraft(mkOffer('Members lunch', { identity_tiers: ['T1'] }));
  await publisher.publish(lunch.offer_id, { bounty: { type: 'fixed', amount: pence(800) } });

  // the seeded tier fallback + a REAL active B23 link for ada
  await pool.query(
    `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status)
     VALUES ($1, $2, 'Member', 'active')`,
    [ADA, ADA_SEED_SUBHASH],
  );
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ('usr_wtless_ada', 'ada@wtless.test')`);
  await pool.query(
    `INSERT INTO wallet.identity_links
       (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes, status, linked_at)
     VALUES ('lnk_0000000000000000000WTLESS', 'usr_wtless_ada', $1, $2, $3, $4,
             '["profile","balance","tier"]'::jsonb, 'active', now())`,
    [merchant.merchant_id, PROGRAMME, ADA_MEMBER_REF, ADA_LINK_SUBHASH],
  );

  readOffers = new ReadOffers({
    repository,
    identity: new IdentityStore(pool, new PgIdentityLinkReader(pool)),
    decisioner: new PassthroughDecisioner(),
    guardrails: new NoopGuardrails(),
    quotes: new QuoteService({
      pool,
      tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    }),
    clock: { now: () => new Date() },
    commitmentStatusFor: (cid) => commitmentsClient.status(cid),
    listPriceFor: () => pence(8450),
  });
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('walletless-T1 via IdentityLink sub_hash (PH1-15 gate)', () => {
  it('a plain SDK agent presenting the link sub_hash gets a T1 member-priced quote incl. the T1-gated offer', async () => {
    // NO consumer_ref / wallet session — only the agent-supplied sub_hash
    const response = await readOffers.read({
      agent: { agent_id: agentId },
      consumer: { sub_hash: ADA_LINK_SUBHASH },
      query: {},
    });
    expect(response.quotes).toHaveLength(2); // spa (all tiers) + members-only lunch
    expect(new Set(response.quotes.map((q) => q.tier))).toEqual(new Set(['T1']));
    expect(response.quotes.every((q) => q.segment === 't1-member-new')).toBe(true);
    // the token proves the quote path minted end to end for a walletless caller
    expect(response.quotes.every((q) => q.token !== null)).toBe(true);
  });

  it('without any T1 signal the same agent is T3 — sees only the all-tier offer', async () => {
    const response = await readOffers.read({ agent: { agent_id: agentId }, query: {} });
    expect(response.quotes).toHaveLength(1); // only the all-tier spa
    expect(response.quotes[0]!.tier).toBe('T3');
  });

  it('revoking the link downgrades the very next quote to T3 (live check, no cache window)', async () => {
    await pool.query(`UPDATE wallet.identity_links SET status = 'revoked' WHERE consumer_ref = 'usr_wtless_ada'`);
    const response = await readOffers.read({
      agent: { agent_id: agentId },
      consumer: { sub_hash: ADA_LINK_SUBHASH },
      query: {},
    });
    // T1-gated lunch drops out; the remaining quote is T3
    expect(response.quotes).toHaveLength(1);
    expect(response.quotes[0]!.tier).toBe('T3');
    await pool.query(`UPDATE wallet.identity_links SET status = 'active' WHERE consumer_ref = 'usr_wtless_ada'`);
  });
});
