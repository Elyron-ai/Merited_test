import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, pence, type MerchantCommercial } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { canonicalJson } from '@merited/events';
import { FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../apps/core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
import { MeritedApiError, MeritedClient } from './index.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_sdk_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'sdk-test';
const SIGNER_SECRET = 'trio-test-secret';
const signer = new FakeSigner(SIGNER_SECRET);

let admin: pg.Client;
let trio: SimulatedTrio;
let core: SimulatedCore;
let coreUrl: string;
let merchantKey: string;
let signingKeyRef: string;
let merchantId: `mer_${string}`;

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
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;

  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  // Aurora Experiences with a published £12.00 fixed-CPA offer
  const merchant = await core.merchants.create({ name: 'Aurora Experiences', commercial });
  merchantId = merchant.merchant_id;
  const issued = await core.merchants.requestSigningKey(merchant.merchant_id);
  signingKeyRef = issued.signing_key_ref;
  merchantKey = (await core.merchants.issueApiKey(merchant.merchant_id)).api_key;
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
});

afterAll(async () => {
  await core.close();
  await trio.close();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('SDK (CORE-13 accept) — the full Act-1 call sequence', () => {
  it('register → readOffers → getQuote → submitClaim → getClaim, all runtime-validated', async () => {
    const client = new MeritedClient({ baseUrl: coreUrl, merchantApiKey: merchantKey });

    // 1 — register (the client adopts its own key)
    const registration = await client.register({ name: 'Valet', contact: 'valet@example.test' });
    expect(registration.agent_id).toMatch(/^agt_/);

    // 2 — readOffers: a payable quote with a quote-bound token
    const read = await client.readOffers({ text: 'spa' });
    expect(read.quotes).toHaveLength(1);
    const quote = read.quotes[0]!;
    expect(quote.token).not.toBeNull();
    expect(read.hint).toBeUndefined();

    // 3 — getQuote: live
    expect((await client.getQuote(quote.quote_id)).status).toBe('live');

    // 4 — submitClaim: the merchant-side formed claim over the agent's token
    const base = {
      claim_id: newId('clm'),
      merchant_id: merchantId,
      attribution_token: quote.token!,
      order: {
        order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        gross_value: quote.price.final,
        ts: iso(10),
      },
    };
    const merchant_sig = await signer.sign(signingKeyRef, canonicalJson(base));
    const submitted = await client.submitClaim(
      { ...base, merchant_sig },
      { idempotencyKey: base.claim_id },
    );
    expect(submitted).toEqual({ claim_id: base.claim_id, verdict: 'verified' });

    // 5 — getClaim as the agent + quote flips to converted; the verified
    // claim carries the balanced settlement preview (VAL-7's CLI print)
    const status = await client.getClaim(base.claim_id);
    expect(status).toMatchObject({ claim_id: base.claim_id, status: 'verified', verdict: 'verified' });
    expect(status.entries_preview?.lines.map((l) => l.amount.amount)).toEqual([1200, 720, 240, 240]);
    expect((await client.getQuote(quote.quote_id)).status).toBe('converted');
  });

  it('anonymous client: degraded read with hint; typed errors carry codes and reason codes', async () => {
    const anonymous = new MeritedClient({ baseUrl: coreUrl });
    const read = await anonymous.readOffers();
    expect(read.hint).toEqual({ register_to_earn: true, register_url: '/v1/agents/register' });
    expect(read.quotes.every((q) => q.token === null)).toBe(true);

    const badKey = new MeritedClient({ baseUrl: coreUrl, apiKey: 'mak_not-real' });
    await expect(badKey.readOffers()).rejects.toMatchObject({
      name: 'MeritedApiError',
      status: 401,
      code: 'AGENT_AUTH_FAILED',
    });
    expect(new MeritedApiError(404, 'QUOTE_NOT_FOUND').message).toContain('QUOTE_NOT_FOUND');

    await expect(anonymous.submitClaim({} as never, { idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'MERCHANT_KEY_REQUIRED',
    });
  });

  it('getOffer issues fresh single-offer quotes through the SDK', async () => {
    const client = new MeritedClient({ baseUrl: coreUrl });
    await client.register({ name: 'Second agent', contact: 'a2@example.test' });
    const offers = await client.readOffers();
    const offerId = offers.quotes[0]!.offer_id;
    const first = await client.getOffer(offerId);
    const second = await client.getOffer(offerId);
    expect(first.quote.quote_id).not.toBe(second.quote.quote_id);
    expect(first.quote.token).not.toBeNull();
  });

  it('hygiene: zero locally-defined exported types; runtime deps are contracts only', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/export\s+(?:type|interface)\s/); // classes are values, not shapes
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).toEqual(['@merited/contracts']);
  });
});
