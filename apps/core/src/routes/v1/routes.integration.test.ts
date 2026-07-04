import {
  newId,
  pence,
  type AttributionTokenClaims,
  type MerchantCommercial,
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
import { InMemoryRateLimiter } from '../../modules/adapters/rate-limiter/in-memory.js';
import { PassthroughDecisioner } from '../../modules/decisioning/index.js';
import { NoopGuardrails } from '../../modules/guardrails/index.js';
import { IdentityStore } from '../../modules/identity/store.js';
import { AgentsService } from '../../modules/agents/service.js';
import { MerchantsService } from '../../modules/merchants/service.js';
import { TrioKeysClient } from '../../modules/merchants/trio-keys-client.js';
import { OfferPublisher } from '../../modules/offers/publisher.js';
import { ReadOffers } from '../../modules/offers/read-offers.js';
import { OffersRepository } from '../../modules/offers/repository.js';
import { OffersService } from '../../modules/offers/service.js';
import { TrioCommitmentsClient } from '../../modules/offers/trio-commitments-client.js';
import { QuoteService } from '../../modules/quotes/service.js';
import { TrioTokenClient } from '../../modules/token-client/client.js';
import { createCoreServer, type CoreServer } from '../../server.js';
import { registerV1Routes, ROUTE_CLASSIFICATIONS } from './index.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_v1_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'v1-routes-test';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let app: CoreServer;
let apiKey: string;
let offerId: string;
const seenRoutes: string[] = [];

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const decodeClaims = (token: string): AttributionTokenClaims =>
  JSON.parse(Buffer.from(token.split('.')[3]!, 'base64url').toString('utf8')) as AttributionTokenClaims;

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
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 'trio-test-secret',
  });
  const trioUrl = await trio.listen();

  const repository = new OffersRepository(drizzle(pool));
  const offersService = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('v1-crypter'),
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
  const offer = await offersService.createDraft({
    merchant_id: merchant.merchant_id,
    title: 'Spa day',
    description: 'Spa day at Aurora',
    mechanics: { type: 'percentage_off', pct_bps: 1500 },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
  });
  await publisher.publish(offer.offer_id, { bounty: { type: 'fixed', amount: pence(1200) } });
  offerId = offer.offer_id;

  const agents = new AgentsService(pool);
  const readOffers = new ReadOffers({
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
  });

  app = createCoreServer();
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== 'HEAD' && method !== 'OPTIONS') seenRoutes.push(`${method} ${route.url}`);
    }
  });
  registerV1Routes(app, {
    readOffers,
    quotes: new QuoteService({
      pool,
      tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    }),
    agents,
    readLimiter: new InMemoryRateLimiter({ limit: 25, windowS: 3600 }),
    registerLimiter: new InMemoryRateLimiter({ limit: 10, windowS: 3600 }),
  });
  await app.ready();

  const registered = await agents.register({ name: 'Valet', contact: 'valet@example.test' });
  apiKey = registered.api_key;
});

afterAll(async () => {
  await app.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('Phase-0 REST surface (CORE-12 accept)', () => {
  it('B4 at HTTP level: anonymous 200-degraded with hint; registered gets tokens; invalid key 401', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/offers' });
    expect(anonymous.statusCode).toBe(200);
    const anonBody = anonymous.json();
    expect(anonBody.hint).toEqual({ register_to_earn: true, register_url: '/v1/agents/register' });
    expect(anonBody.quotes[0].token).toBeNull();

    const registered = await app.inject({
      method: 'GET',
      url: '/v1/offers',
      headers: { 'x-merited-agent-key': apiKey },
    });
    expect(registered.statusCode).toBe(200);
    const regBody = registered.json();
    expect(regBody.hint).toBeUndefined();
    expect(regBody.quotes[0].token).not.toBeNull();

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/offers',
      headers: { 'x-merited-agent-key': 'mak_not-a-real-key' },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('GET /v1/offers/:id issues a FRESH token every call (quotes are cheap promises)', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/v1/offers/${offerId}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    const second = await app.inject({
      method: 'GET',
      url: `/v1/offers/${offerId}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    expect(first.statusCode).toBe(200);
    const jti1 = decodeClaims(first.json().quote.token).jti;
    const jti2 = decodeClaims(second.json().quote.token).jti;
    expect(jti1).not.toBe(jti2);
    expect(first.json().quote.quote_id).not.toBe(second.json().quote.quote_id);

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/offers/${newId('off')}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /v1/quotes/:id returns derived status + the persisted promise; unknown → 404', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/v1/offers/${offerId}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    const quoteId = read.json().quote.quote_id;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/quotes/${quoteId}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'live',
      quote: { quote_id: quoteId, offer_id: offerId, price: { final: { amount: 7183 } } },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/quotes/${newId('qte')}`,
      headers: { 'x-merited-agent-key': apiKey },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rate-limit breach → 429 with Retry-After', async () => {
    let denied = false;
    for (let i = 0; i < 30 && !denied; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/offers',
        headers: { 'x-merited-agent-key': apiKey },
      });
      if (res.statusCode === 429) {
        denied = true;
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
    }
    expect(denied).toBe(true);
  });

  it('route audit (§8): every registered route is classified authenticated or explicitly degraded', async () => {
    expect(seenRoutes.length).toBeGreaterThanOrEqual(4);
    for (const route of seenRoutes) {
      expect(
        ROUTE_CLASSIFICATIONS[route],
        `unclassified route: ${route} — every route must be authenticated or explicitly anonymous-degraded`,
      ).toBeDefined();
    }
  });
});
