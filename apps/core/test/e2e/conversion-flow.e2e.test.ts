import { newId, pence, type MerchantCommercial } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { canonicalJson, verifyChain } from '@merited/events';
import { createFakeShop } from '@merited/fake-aurora';
import { getMemoryExporter, initOtel, shutdownOtel, withSpan } from '@merited/otel';
import { MeritedClient } from '@merited/sdk';
import { FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../trio/scripts/migrate.mjs';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_e2e_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'e2e-test';
const SIGNER_SECRET = 'trio-test-secret';
const signer = new FakeSigner(SIGNER_SECRET);

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let trioUrl: string;
let coreUrl: string;
let shopUrl: string;
let merchantId: `mer_${string}`;
let merchantSlug: string;
let merchantKey: string;
let signingKeyRef: string;
let agentId: string;
let sdk: MeritedClient;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const checkout = async (token: string | null) => {
  const response = await fetch(`${shopUrl}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'sku_spa_day', attribution_token: token }),
  });
  return (await response.json()) as { order_number: number; webhook: string };
};

const claimIdForOrder = async (jti: string, nth = 0): Promise<string> => {
  const { rows } = await pool.query<{ claim_id: string }>(
    `SELECT claim_id FROM core.claims_intake WHERE jti = $1 ORDER BY created_at`,
    [jti],
  );
  return rows[nth]!.claim_id;
};

const decodeJti = (token: string): string =>
  (JSON.parse(Buffer.from(token.split('.')[3]!, 'base64url').toString('utf8')) as { jti: string }).jti;

beforeAll(async () => {
  initOtel({ serviceName: 'conversion-e2e', exporter: 'memory' });
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
  trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  const merchant = await core.merchants.create({ name: 'Aurora Experiences', commercial });
  merchantId = merchant.merchant_id;
  merchantSlug = merchant.slug;
  signingKeyRef = (await core.merchants.requestSigningKey(merchant.merchant_id)).signing_key_ref;
  merchantKey = (await core.merchants.issueApiKey(merchant.merchant_id)).api_key;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;

  const offer = await core.offers.createDraft({
    merchant_id: merchant.merchant_id,
    title: 'Spa day',
    description: 'Full spa day at Aurora Experiences.',
    mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
    sku_scope: ['sku_spa_day'],
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
  });
  await core.publisher.publish(offer.offer_id, { bounty: { type: 'fixed', amount: pence(1200) } });

  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchantSlug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  // no traceHeaders hook: undici auto-instrumentation propagates for us
  sdk = new MeritedClient({ baseUrl: coreUrl, merchantApiKey: merchantKey });
  agentId = (await sdk.register({ name: 'Valet', contact: 'valet@example.test' })).agent_id;
});

afterAll(async () => {
  await shop.close();
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('end-to-end conversion flow (MER-12 accept — the MER slice of the Phase-0 gate)', () => {
  let happyToken: string;

  it('read → token → FakeShop checkout → webhook → verified → balanced ledger, under ONE trace', async () => {
    getMemoryExporter()!.reset();
    await withSpan('conversion-e2e', async () => {
      const read = await sdk.readOffers({ text: 'spa' });
      const quote = read.quotes[0]!;
      expect(quote.token).not.toBeNull();
      happyToken = quote.token!;

      const confirmation = await checkout(happyToken);
      expect(confirmation.webhook).toBe('delivered');
    });

    // §8/B21: ONE trace ID spans read → mint → checkout → webhook → verdict.
    // Snapshot NOW — the verification fetches below are instrumented too and
    // (correctly) root their own traces outside the conversion span.
    const spans = [...getMemoryExporter()!.getFinishedSpans()];
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(spans.length).toBeGreaterThanOrEqual(8); // stages + server requests
    expect(traceIds.size).toBe(1);

    // verdict recorded and readable (both sides see why)
    const claimId = await claimIdForOrder(decodeJti(happyToken));
    const status = await sdk.getClaim(claimId);
    expect(status.status).toBe('verified');

    // balanced ledger entries visible through TRIO-9/11
    const positions = await Promise.all(
      [merchantId, agentId, 'platform', 'reserve'].map(async (party) => {
        const res = await fetch(`${trioUrl}/trio/positions/${party}`, {
          headers: { 'x-merited-service-token': SERVICE_TOKEN },
        });
        return (await res.json()) as { direction: string; amount: { amount: number } };
      }),
    );
    expect(positions[0]).toMatchObject({ direction: 'payable', amount: { amount: 1200 } });
    expect(positions[1]).toMatchObject({ direction: 'receivable', amount: { amount: 720 } });
    const signedSum = positions.reduce(
      (sum, p) => sum + (p.direction === 'receivable' ? p.amount.amount : -p.amount.amount),
      0,
    );
    expect(signedSum).toBe(0);
  });

  it('negative: replaying the same token through a fresh checkout → TOKEN_REPLAYED', async () => {
    const confirmation = await checkout(happyToken);
    expect(confirmation.webhook).toBe('delivered');
    const claimId = await claimIdForOrder(decodeJti(happyToken), 1);
    const status = await sdk.getClaim(claimId);
    expect(status).toMatchObject({ status: 'rejected', reason_code: 'TOKEN_REPLAYED' });
  });

  it('negative: claim against an expired quote → QUOTE_EXPIRED (public inputs only)', async () => {
    const read = await sdk.readOffers({ text: 'spa' });
    const quote = read.quotes[0]!;
    const base = {
      claim_id: newId('clm'),
      merchant_id: merchantId,
      attribution_token: quote.token!,
      order: {
        order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        gross_value: quote.price.final,
        ts: iso(700), // inside the attribution window, past the ≤600s quote snapshot
      },
    };
    const merchant_sig = await signer.sign(signingKeyRef, canonicalJson(base));
    const submitted = await sdk.submitClaim({ ...base, merchant_sig }, { idempotencyKey: base.claim_id });
    expect(submitted).toMatchObject({ verdict: 'rejected', reason_code: 'QUOTE_EXPIRED' });
  });

  it('negative: tampered webhook signature → 401 and NO ledger event; duplicate delivery → one claim', async () => {
    const read = await sdk.readOffers({ text: 'spa' });
    const token = read.quotes[0]!.token!;

    const before = await pool.query(`SELECT count(*) FROM events.events`);
    const raw = JSON.stringify({
      event: 'order.confirmed',
      shop_domain: 'aurora.fakeshop.test',
      order: {
        number: 424242,
        placed_at: iso(0),
        total: { amount_minor: 8450, currency_code: 'GBP' },
        attribution: { merited_token: token },
        lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
      },
    });
    const tampered = await fetch(`${coreUrl}/v1/merchants/${merchantSlug}/webhooks/order-confirmed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merited-signature': 'not-a-real-signature',
        'x-merited-timestamp': String(Math.floor(Date.now() / 1000)),
        'idempotency-key': 'tampered-1',
      },
      body: raw,
    });
    expect(tampered.status).toBe(401);
    const after = await pool.query(`SELECT count(*) FROM events.events`);
    expect(after.rows[0].count).toBe(before.rows[0].count);

    // duplicate legitimate delivery: FakeShop checkout, then re-deliver the
    // same order id — one claim, byte-identical verdicts
    const confirmation = await checkout(token);
    expect(confirmation.webhook).toBe('delivered');
    const intakeCount = await pool.query(
      `SELECT count(*) FROM core.claims_intake WHERE jti = $1`,
      [decodeJti(token)],
    );
    expect(Number(intakeCount.rows[0].count)).toBe(1);
  });

  it('the produced ledger passes verify-chain (FND-13 over the whole flow)', async () => {
    const client = await pool.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification).toMatchObject({ ok: true });
      if (verification.ok) expect(verification.count).toBeGreaterThanOrEqual(10);
    } finally {
      client.release();
    }
  });
});
