import {
  newId,
  pence,
  type FakeShopOrderWebhook,
  type MerchantCommercial,
  type Merchant,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
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
import { MerchantsService } from '../../merchants/service.js';
import { TrioKeysClient } from '../../merchants/trio-keys-client.js';
import { OfferPublisher } from '../../offers/publisher.js';
import { OffersRepository } from '../../offers/repository.js';
import { OffersService } from '../../offers/service.js';
import { TrioCommitmentsClient } from '../../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../../token-client/client.js';
import { buildSignedClaim, decodeTokenClaims } from './claim-builder.js';
import { normaliseOrder } from './normalise.js';
import { GradeBOrderProcessor } from './processor.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_m4_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'mer4-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let processor: GradeBOrderProcessor;
let merchant: Merchant;
let mintToken: (grossQuoteExpS?: number) => Promise<string>;
const dropLogs: Array<Record<string, unknown>> = [];

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const webhookFor = (token: string | null, number = Math.floor(Math.random() * 100000) + 1): FakeShopOrderWebhook => ({
  event: 'order.confirmed',
  shop_domain: 'aurora.fakeshop.test',
  order: {
    number,
    placed_at: iso(5),
    total: { amount_minor: 8450, currency_code: 'GBP' },
    attribution: { merited_token: token },
    lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
  },
});

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
  trioUrl = await trio.listen();

  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('mer4-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const created = await merchants.create({ name: 'Aurora Experiences', commercial });
  await merchants.requestSigningKey(created.merchant_id);
  merchant = await merchants.get(created.merchant_id);

  // a published COR to mint real tokens against
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
  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  mintToken = async (quoteExpS = 300) => {
    const minted = await tokenClient.mint({
      cid: published.commitment_id as `com_${string}`,
      qid: newId('qte'),
      aid: newId('agt'),
      tier: 'T3',
      session_nonce: 'mer4',
      quote: { expires_at: iso(quoteExpS), mandate_ref: null },
    });
    if (!minted.ok) throw new Error(minted.error.code);
    return minted.minted.token;
  };

  processor = new GradeBOrderProcessor({
    pool,
    signer: new FakeSigner(SIGNER_SECRET),
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    logger: {
      info: (payload) => void dropLogs.push(payload),
      warn: (payload) => void dropLogs.push(payload),
    },
  });
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('Grade-B processor: normalise → sign → submit (MER-4 accept)', () => {
  it('happy path (§10 Act 1 step 5): webhook → signed claim → verified; intake + event recorded', async () => {
    const token = await mintToken();
    const result = await processor.processOrder(webhookFor(token), merchant);
    expect(result.status).toBe(200);
    expect(result.body['verdict']).toBe('verified');

    const claimId = result.body['claim_id'] as string;
    const intake = await pool.query(
      `SELECT verdict, reason_code, gross_pence, jti, qid, cid FROM core.claims_intake WHERE claim_id = $1`,
      [claimId],
    );
    expect(intake.rows[0]).toMatchObject({ verdict: 'verified', reason_code: null, gross_pence: 8450 });

    // ConversionClaimed body carries merchant_id, jti, qid, cid, order_ref_hash, gross_value
    const claims = decodeTokenClaims(token)!;
    const event = await pool.query(
      `SELECT body->'data' AS data FROM events.events WHERE type = 'ConversionClaimed'
        AND body->'data'->>'claim_id' = $1`,
      [claimId],
    );
    expect(event.rows[0].data).toMatchObject({
      merchant_id: merchant.merchant_id,
      jti: claims.jti,
      qid: claims.qid,
      cid: claims.cid,
      gross_value: { amount: 8450, currency: 'GBP_pence' },
    });
    expect(typeof event.rows[0].data.order_ref_hash).toBe('string');
  });

  it('key hierarchy: a claim signed with the PLATFORM key ref fails trio verification as SIG_INVALID', async () => {
    const token = await mintToken();
    const order = { ...normaliseOrder(webhookFor(token)), token };
    const signer = new FakeSigner(SIGNER_SECRET);
    const wrongKeyClaim = await buildSignedClaim(
      order,
      { merchant_id: merchant.merchant_id, signing_key_ref: 'platform/mint' }, // WRONG hierarchy
      signer,
    );
    const response = await fetch(`${trioUrl}/trio/claims/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merited-service-token': SERVICE_TOKEN,
        'idempotency-key': newId('clm'),
      },
      body: JSON.stringify(wrongKeyClaim),
    });
    expect(await response.json()).toEqual({ verdict: 'rejected', reason_code: 'SIG_INVALID' });
  });

  it('token-less order: NO claim, NO ledger event, structured TOKEN_ABSENT log, 200 to the shop', async () => {
    const before = await pool.query(`SELECT count(*) FROM core.claims_intake`);
    const eventsBefore = await pool.query(`SELECT count(*) FROM events.events WHERE type = 'ConversionClaimed'`);

    const result = await processor.processOrder(webhookFor(null), merchant);
    expect(result).toEqual({ status: 200, body: { outcome: 'ignored', reason: 'TOKEN_ABSENT' } });

    const after = await pool.query(`SELECT count(*) FROM core.claims_intake`);
    const eventsAfter = await pool.query(`SELECT count(*) FROM events.events WHERE type = 'ConversionClaimed'`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(eventsAfter.rows[0].count).toBe(eventsBefore.rows[0].count);
    expect(dropLogs.some((l) => l['reason'] === 'TOKEN_ABSENT' && l['merchant_slug'] === merchant.slug)).toBe(true);
  });

  it('a replayed token yields a persisted TOKEN_REPLAYED verdict — both sides see why', async () => {
    const token = await mintToken();
    const first = await processor.processOrder(webhookFor(token), merchant);
    expect(first.body['verdict']).toBe('verified');
    const second = await processor.processOrder(webhookFor(token), merchant);
    expect(second.body).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
    const intake = await pool.query(
      `SELECT verdict, reason_code FROM core.claims_intake WHERE claim_id = $1`,
      [second.body['claim_id']],
    );
    expect(intake.rows[0]).toEqual({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
  });

  it('normalisation drops the basket and hashes the ref; the signed payload is canonical-minus-sig', async () => {
    const payload = webhookFor('tok', 4242);
    const order = normaliseOrder(payload);
    expect(order.order_ref_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(order)).not.toContain('sku_spa_day'); // basket dropped
    expect(order.gross_value).toEqual(pence(8450));

    const signer = new FakeSigner(SIGNER_SECRET);
    const claim = await buildSignedClaim(
      { ...order, token: 'tok' },
      { merchant_id: merchant.merchant_id, signing_key_ref: merchant.signing_key_ref! },
      signer,
    );
    const { merchant_sig, ...unsigned } = claim;
    expect(
      await signer.verify(merchant.signing_key_ref!, canonicalJson(unsigned), merchant_sig),
    ).toBe(true);
  });
});
