import {
  getMemoryExporter,
  initOtel,
  shutdownOtel,
} from '@merited/otel';
import {
  OfferReadResponse,
  newId,
  pence,
  type MerchantCommercial,
  type Offer,
} from '@merited/contracts';
import { FakeCrypter } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import { decisionerFor, PassthroughDecisioner } from '../decisioning/index.js';
import { NoopGuardrails } from '../guardrails/index.js';
import { IdentityStore } from '../identity/store.js';
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { QuoteService } from '../quotes/service.js';
import { TrioTokenClient } from '../token-client/client.js';
import { OfferPublisher } from './publisher.js';
import { ReadOffers } from './read-offers.js';
import { OffersRepository } from './repository.js';
import { OffersService } from './service.js';
import { TrioCommitmentsClient } from './trio-commitments-client.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_ro_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'read-offers-test';
const agentId = newId('agt');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let readOffers: ReadOffers;
let baseDeps: ConstructorParameters<typeof ReadOffers>[0];

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

beforeAll(async () => {
  initOtel({ serviceName: 'read-offers-test', exporter: 'memory' });
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
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 'trio-test-secret',
  });
  const trioUrl = await trio.listen();

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('read-offers-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const commitmentsClient = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: commitmentsClient,
    merchantFor: (id) => merchants.get(id),
  });

  // fixtures: one payable spa offer, one payable lunch offer (T1-only),
  // one display-only offer, one draft (never a candidate)
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
  const lunch = await offers.createDraft(mkOffer('Lunch tasting', { identity_tiers: ['T1'] }));
  await publisher.publish(lunch.offer_id, { bounty: { type: 'fixed', amount: pence(800) } });
  const displayOnly = await offers.createDraft(mkOffer('Loyalty double points'));
  await publisher.publish(displayOnly.offer_id); // no bounty, no COR
  await offers.createDraft(mkOffer('Unpublished draft'));

  baseDeps = {
    repository,
    identity: new IdentityStore(pool),
    decisioner: new PassthroughDecisioner(),
    guardrails: new NoopGuardrails(),
    quotes: new QuoteService({
      pool,
      tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    }),
    clock: { now: () => new Date() },
    commitmentStatusFor: (cid) => commitmentsClient.status(cid),
    listPriceFor: () => pence(8450),
  };
  readOffers = new ReadOffers(baseDeps);
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('readOffers pipeline assembly (CORE-11 accept)', () => {
  it('(1) verified agent: every payable quote carries a token; T3 sees only tier-eligible offers', async () => {
    const response = await readOffers.read({ agent: { agent_id: agentId }, query: {} });
    expect(OfferReadResponse.parse(response)).toEqual(response);
    expect(response.hint).toBeUndefined();
    // spa is payable+eligible; lunch is T1-only (excluded for T3); display-only unquoted
    expect(response.quotes).toHaveLength(1);
    expect(response.quotes[0]!.token).not.toBeNull();
    expect(response.quotes[0]!.price.final).toEqual(pence(7183));
  });

  it('(2) anonymous agent: token: null quotes plus the register_to_earn hint', async () => {
    const response = await readOffers.read({ agent: { agent_id: null }, query: {} });
    expect(response.hint).toEqual({ register_to_earn: true, register_url: '/v1/agents/register' });
    expect(response.quotes).toHaveLength(1);
    expect(response.quotes[0]!.token).toBeNull();
    expect(response.quotes[0]!.agent_id).toBeNull();
  });

  it('(3) exactly one trace ID spans candidates → resolve → … → quote/mint', async () => {
    getMemoryExporter()!.reset();
    await readOffers.read({ agent: { agent_id: agentId }, query: { text: 'spa' } });
    const spans = getMemoryExporter()!.getFinishedSpans();
    const names = spans.map((s) => s.name);
    for (const stage of [
      'read_offers',
      'read_offers.candidates',
      'read_offers.resolve_identity',
      'read_offers.filter_eligibility',
      'read_offers.decisioning',
      'read_offers.guardrails',
      'read_offers.quote',
    ]) {
      expect(names, `missing span: ${stage}`).toContain(stage);
    }
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1); // §8: ONE trace from readOffers through mint
  });

  it('query filters: text ILIKE, sku scope, merchant scoping', async () => {
    const byText = await readOffers.read({ agent: { agent_id: agentId }, query: { text: 'SPA' } });
    expect(byText.quotes).toHaveLength(1);

    const bySku = await readOffers.read({
      agent: { agent_id: agentId },
      query: { sku: 'sku_spa_day' },
    });
    expect(bySku.quotes).toHaveLength(1);

    const byMerchant = await readOffers.read({
      agent: { agent_id: agentId },
      query: { merchant_id: newId('mer') },
    });
    expect(byMerchant.quotes).toHaveLength(0);
  });

  it('PH1-4 accept: swapping RulesDecisioner for RandomDecisioner changes ranking ONLY — no schema/API diffs', async () => {
    // (re-used verbatim at the Phase-2 gate for the ML sidecar swap)
    await pool.query(
      `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status) VALUES
       ('AUR-9002', 'swap-proof-gold', 'Gold', 'active')`,
    );
    const run = async (name: string) => {
      const instance = new ReadOffers({ ...baseDeps, decisioner: decisionerFor(name) });
      const response = await instance.read({
        agent: { agent_id: agentId },
        consumer: { sub_hash: 'swap-proof-gold' }, // T1 → two payable quotes
        query: {},
      });
      expect(OfferReadResponse.parse(response)).toEqual(response); // schema identical
      return response;
    };
    const rules = await run('rules');
    // find the first seed whose shuffle disagrees with rules order — the
    // PRNG is fixed, so this walk is deterministic run to run
    let random = await run('random:1');
    for (const seed of [2, 3, 4, 5, 6]) {
      if (
        random.quotes.map((q) => q.offer_id).join() !== rules.quotes.map((q) => q.offer_id).join()
      )
        break;
      random = await run(`random:${seed}`);
    }

    // every NON-ORDERING field identical: normalise away per-mint volatility
    // (fresh quote ids/tokens/expiries are minted per read BY DESIGN)
    const normalise = (response: typeof rules) =>
      response.quotes
        .map(({ quote_id: _q, token, expires_at: _e, ...rest }) => ({
          ...rest,
          payable: token !== null,
        }))
        .sort((a, b) => (a.offer_id < b.offer_id ? -1 : 1));
    expect(normalise(random)).toEqual(normalise(rules));

    // …and ranking is genuinely what changed
    expect(random.quotes.map((q) => q.offer_id)).not.toEqual(
      rules.quotes.map((q) => q.offer_id),
    );
  });

  it('a T1 consumer signal unlocks the tier-gated offer through the same pipeline', async () => {
    await pool.query(
      `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status) VALUES
       ('AUR-9001', 'readoffers-gold', 'Gold', 'active')`,
    );
    const response = await readOffers.read({
      agent: { agent_id: agentId },
      consumer: { sub_hash: 'readoffers-gold' },
      query: {},
    });
    expect(response.quotes).toHaveLength(2); // spa + T1-only lunch
    expect(new Set(response.quotes.map((q) => q.tier))).toEqual(new Set(['T1']));
    expect(response.quotes.every((q) => q.segment === 't1-gold-new')).toBe(true);
  });
});
