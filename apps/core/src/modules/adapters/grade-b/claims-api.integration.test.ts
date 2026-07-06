import {
  REJECTION_REASON_CODES,
  newId,
  pence,
  type Merchant,
  type MerchantCommercial,
} from '@merited/contracts';
import { FakeCrypter, FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../../trio/scripts/migrate.mjs';
import { InMemoryRateLimiter } from '../rate-limiter/in-memory.js';
import { AgentsService } from '../../agents/service.js';
import { MerchantsService } from '../../merchants/service.js';
import { TrioKeysClient } from '../../merchants/trio-keys-client.js';
import { OfferPublisher } from '../../offers/publisher.js';
import { OffersRepository } from '../../offers/repository.js';
import { OffersService } from '../../offers/service.js';
import { TrioCommitmentsClient } from '../../offers/trio-commitments-client.js';
import { QuoteService } from '../../quotes/service.js';
import { TrioTokenClient } from '../../token-client/client.js';
import { createCoreServer, type CoreServer } from '../../../server.js';
import { buildSignedClaim } from './claim-builder.js';
import { registerClaimsRoutes } from './claims-routes.js';
import { GradeBOrderProcessor } from './processor.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_m5_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'mer5-test';
const SIGNER_SECRET = 'trio-test-secret';
const signer = new FakeSigner(SIGNER_SECRET);

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let app: CoreServer;
let merchant: Merchant;
let merchantKey: string;
let agentKey: string;
let agentId: `agt_${string}`;
let quotes: QuoteService;
let commitmentId: `com_${string}`;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A formed, signed claim over a freshly minted (payable) quote token. */
const formedClaim = async () => {
  const [quote] = await quotes.issueQuotes(
    [
      {
        offer: {
          offer_id: newId('off'), // synthetic ranked entry; the COR is what matters
          merchant_id: merchant.merchant_id,
          title: 'Spa day',
          description: 'Spa day',
          mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
          sku_scope: ['sku_spa_day'],
          identity_tiers: ['T1', 'T2', 'T3'],
          stacking_group: null,
          status: 'live',
          valid_from: iso(-3600),
          valid_until: iso(180 * 86400),
        },
        commitment_id: commitmentId,
      },
    ],
    {
      agent: { agent_id: agentId },
      tier: 'T3',
      segment: 't3-acquisition',
      listPriceFor: () => pence(8450),
    },
  );
  return buildSignedClaim(
    {
      order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      gross_value: pence(8450),
      ts: iso(10),
      token: quote!.token!,
    },
    { merchant_id: merchant.merchant_id, signing_key_ref: merchant.signing_key_ref! },
    signer,
  );
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
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const trioUrl = await trio.listen();

  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('mer5-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const created = await merchants.create({ name: 'Aurora Experiences', commercial });
  await merchants.requestSigningKey(created.merchant_id);
  merchant = await merchants.get(created.merchant_id);
  merchantKey = (await merchants.issueApiKey(merchant.merchant_id)).api_key;

  const agents = new AgentsService(pool);
  const registered = await agents.register({ name: 'Valet', contact: 'valet@example.test' });
  agentId = registered.agent_id;
  agentKey = registered.api_key;

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    merchantFor: (id) => merchants.get(id),
  });
  const offer = await offers.createDraft({
    merchant_id: merchant.merchant_id,
    title: 'Spa day',
    description: 'Spa day',
    mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
    sku_scope: ['sku_spa_day'],
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
  });
  const published = await publisher.publish(offer.offer_id, {
    bounty: { type: 'fixed', amount: pence(1200) },
  });
  commitmentId = published.commitment_id as `com_${string}`;
  quotes = new QuoteService({
    pool,
    tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  });

  app = createCoreServer();
  registerClaimsRoutes(app, {
    pool,
    merchants,
    agents,
    submitter: new GradeBOrderProcessor({
      pool,
      signer,
      trioBaseUrl: trioUrl,
      trioServiceToken: SERVICE_TOKEN,
    }),
    limiter: new InMemoryRateLimiter({ limit: 50, windowS: 3600 }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('claims API (MER-5 accept)', () => {
  it('unauthenticated / invalid merchant key → 401 (§8 authn on every route)', async () => {
    const claim = await formedClaim();
    const bare = await app.inject({ method: 'POST', url: '/v1/claims', payload: claim });
    expect(bare.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-merited-merchant-key': 'mmk_wrong', 'idempotency-key': 'k1' },
      payload: claim,
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('formed claim through the single funnel → verified; replayed Idempotency-Key → identical bytes, one intake row', async () => {
    const claim = await formedClaim();
    const key = `claim-${claim.claim_id}`;
    const headers = { 'x-merited-merchant-key': merchantKey, 'idempotency-key': key };
    const first = await app.inject({ method: 'POST', url: '/v1/claims', headers, payload: claim });
    expect(first.statusCode).toBe(200);
    expect(first.json().verdict).toBe('verified');

    const replay = await app.inject({ method: 'POST', url: '/v1/claims', headers, payload: claim });
    expect(replay.body).toBe(first.body); // byte-identical
    const rows = await pool.query(`SELECT count(*) FROM core.claims_intake WHERE claim_id = $1`, [
      claim.claim_id,
    ]);
    expect(Number(rows.rows[0].count)).toBe(1); // exactly one submission

    const conflicting = await formedClaim();
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/claims',
      headers,
      payload: conflicting,
    });
    expect(conflict.statusCode).toBe(422);
  });

  it('a claim naming a different merchant is 403 even with valid auth', async () => {
    const claim = await formedClaim();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-merited-merchant-key': merchantKey, 'idempotency-key': newId('clm') },
      payload: { ...claim, merchant_id: newId('mer') },
    });
    // signature also breaks, but the ownership gate fires first with 403
    expect(res.statusCode).toBe(403);
  });

  it('GET /v1/claims/:id — merchant and the token’s agent can read; strangers cannot', async () => {
    const claim = await formedClaim();
    await app.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-merited-merchant-key': merchantKey, 'idempotency-key': claim.claim_id },
      payload: claim,
    });

    const asMerchant = await app.inject({
      method: 'GET',
      url: `/v1/claims/${claim.claim_id}`,
      headers: { 'x-merited-merchant-key': merchantKey },
    });
    expect(asMerchant.statusCode).toBe(200);
    expect(asMerchant.json()).toMatchObject({ claim_id: claim.claim_id, status: 'verified' });

    const asAgent = await app.inject({
      method: 'GET',
      url: `/v1/claims/${claim.claim_id}`,
      headers: { 'x-merited-agent-key': agentKey },
    });
    expect(asAgent.statusCode).toBe(200);

    const anonymous = await app.inject({ method: 'GET', url: `/v1/claims/${claim.claim_id}` });
    expect(anonymous.statusCode).toBe(401);

    // W11/#33: an UNKNOWN claim (even with a valid merchant key) is
    // indistinguishable from an existing-but-not-yours one — uniform 401, no
    // existence oracle. (Previously this leaked a 404.)
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/claims/${newId('clm')}`,
      headers: { 'x-merited-merchant-key': merchantKey },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual(anonymous.json()); // byte-identical refusal
  });

  it('every §3 reason code surfaces verbatim through the GET', async () => {
    for (const code of REJECTION_REASON_CODES) {
      const claimId = newId('clm');
      await pool.query(
        `INSERT INTO core.claims_intake (claim_id, merchant_id, order_ref_hash, gross_pence, verdict, reason_code)
         VALUES ($1, $2, 'hash', 100, 'rejected', $3)`,
        [claimId, merchant.merchant_id, code],
      );
      const res = await app.inject({
        method: 'GET',
        url: `/v1/claims/${claimId}`,
        headers: { 'x-merited-merchant-key': merchantKey },
      });
      expect(res.json()).toEqual({
        claim_id: claimId,
        status: 'rejected',
        verdict: 'rejected',
        reason_code: code,
      });
    }
  });
});
