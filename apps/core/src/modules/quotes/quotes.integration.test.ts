import {
  newId,
  pence,
  quoteExpiryWithinToken,
  type AttributionTokenClaims,
  type MerchantCommercial,
  type Offer,
  type RankedOffer,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { FakeCrypter, FakeSigner } from '@merited/signing';
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
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { OfferPublisher } from '../offers/publisher.js';
import { OffersRepository } from '../offers/repository.js';
import { OffersService } from '../offers/service.js';
import { TrioCommitmentsClient } from '../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../token-client/client.js';
import { QuoteService, type QuoteCtx } from './service.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_qte_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'quotes-test';
const signer = new FakeSigner('trio-test-secret');
const agentId = newId('agt');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let quotes: QuoteService;
let ranked: RankedOffer[]; // two payable offers, published once in beforeAll
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

const ctxFor = (overrides: Partial<QuoteCtx> = {}): QuoteCtx => ({
  agent: { agent_id: agentId },
  tier: 'T3',
  segment: 't3-acquisition',
  listPriceFor: () => pence(8450),
  ...overrides,
});

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
  trioUrl = await trio.listen();

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('quotes-test-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    merchantFor: (id) => merchants.get(id),
  });
  quotes = new QuoteService({
    pool,
    tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  });

  const merchant = await merchants.create({ name: 'Aurora Experiences', commercial });
  merchantId = merchant.merchant_id;
  const mkOffer = (title: string): Omit<Offer, 'offer_id' | 'status'> => ({
    merchant_id: merchant.merchant_id,
    title,
    description: 'Quote fixture',
    mechanics: { type: 'percentage_off', pct_bps: 1500 },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
  });
  ranked = [];
  for (const title of ['Spa day', 'Lunch tasting']) {
    const offer = await offers.createDraft(mkOffer(title));
    const published = await publisher.publish(offer.offer_id, {
      bounty: { type: 'fixed', amount: pence(1200) },
    });
    ranked.push({
      offer: await offers.get(offer.offer_id),
      commitment_id: published.commitment_id as `com_${string}`,
    });
  }
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('quote service (CORE-10 accept, §5.6a — all four clauses)', () => {
  it('(1) every payable read persists exactly one quote per returned offer; (2) every token qid resolves', async () => {
    const before = await pool.query(`SELECT count(*) FROM core.quotes`);
    const issued = await quotes.issueQuotes(ranked, ctxFor());
    const after = await pool.query(`SELECT count(*) FROM core.quotes`);

    expect(issued).toHaveLength(2); // one per payable offer
    expect(Number(after.rows[0].count) - Number(before.rows[0].count)).toBe(2);
    expect(new Set(issued.map((q) => q.offer_id)).size).toBe(2);

    for (const quote of issued) {
      expect(quote.token).not.toBeNull();
      const claims = decodeClaims(quote.token!);
      expect(claims.qid).toBe(quote.quote_id); // token is quote-bound
      const row = await quotes.getQuote(claims.qid); // GET /v1/quotes/:qid is honest
      expect(row.quote_id).toBe(quote.quote_id);
      expect(row.token_jti).toBe(claims.jti);
      // pricing applied against the list price: 8450 − floor(8450×15%) = 7183
      expect(quote.price.final).toEqual(pence(7183));
      expect(await quotes.getQuoteStatus(quote.quote_id)).toBe('live');
    }

    const events = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'QuoteIssued'`,
    );
    expect(Number(events.rows[0].count)).toBeGreaterThanOrEqual(2);
  });

  it('(3) expired quote + fresh claim → QUOTE_EXPIRED from verification (via simulator)', async () => {
    const shortLived = new QuoteService({
      pool,
      tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
      quoteTtlS: 1, // env-gated demo TTL (MERITED_QUOTE_TTL_S, D5) — public input
    });
    const [quote] = await shortLived.issueQuotes([ranked[0]!], ctxFor());
    const claimBase = {
      claim_id: newId('clm'),
      merchant_id: merchantId,
      attribution_token: quote!.token!,
      order: {
        order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        gross_value: pence(8450),
        ts: iso(30), // past the 1s quote TTL, inside every other window
      },
    };
    const merchant_sig = await signer.sign(`merchant/${merchantId}`, canonicalJson(claimBase));
    const response = await fetch(`${trioUrl}/trio/claims/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merited-service-token': SERVICE_TOKEN,
        'idempotency-key': newId('clm'),
      },
      body: JSON.stringify({ ...claimBase, merchant_sig }),
    });
    expect(await response.json()).toEqual({ verdict: 'rejected', reason_code: 'QUOTE_EXPIRED' });
    // status is clock-derived: read it as of +30s (injected clock, no sleep)
    const later = new QuoteService({
      pool,
      tokenClient: { mint: async () => ({ ok: false, error: { code: 'TIMEOUT', message: 'unused' } }) },
      clock: { now: () => new Date(Date.now() + 30_000) },
    });
    expect(await later.getQuoteStatus(quote!.quote_id)).toBe('expired');
  });

  it('(4) price shown at quote time equals the verified claim audit view; status flips to converted', async () => {
    const [quote] = await quotes.issueQuotes([ranked[1]!], ctxFor());
    const claimBase = {
      claim_id: newId('clm'),
      merchant_id: merchantId,
      attribution_token: quote!.token!,
      order: {
        order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        gross_value: quote!.price.final, // the agent paid the quoted price
        ts: iso(10),
      },
    };
    const merchant_sig = await signer.sign(`merchant/${merchantId}`, canonicalJson(claimBase));
    const response = await fetch(`${trioUrl}/trio/claims/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merited-service-token': SERVICE_TOKEN,
        'idempotency-key': newId('clm'),
      },
      body: JSON.stringify({ ...claimBase, merchant_sig }),
    });
    expect(((await response.json()) as { verdict: string }).verdict).toBe('verified');

    // audit path: quote row + inputs_snapshot carry the price the agent saw
    const audit = await quotes.getQuote(quote!.quote_id);
    expect(audit.final_amount).toBe(quote!.price.final.amount);
    const snapshot = audit.inputs_snapshot as { pricing: { final: { amount: number } } };
    expect(snapshot.pricing.final.amount).toBe(quote!.price.final.amount);
    expect(await quotes.getQuoteStatus(quote!.quote_id)).toBe('converted');
  });

  it('property: expires_at ≤ claims.exp on EVERY payable quote, across TTL settings', async () => {
    for (const ttl of [60, 599, 900, 3600]) {
      const service = new QuoteService({
        pool,
        tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
        quoteTtlS: ttl,
      });
      const issued = await service.issueQuotes(ranked, ctxFor());
      for (const quote of issued) {
        expect(quote.token).not.toBeNull();
        expect(quoteExpiryWithinToken(quote, decodeClaims(quote.token!))).toBe(true);
      }
    }
  });

  it('anonymous reads persist unpayable quotes; display-only offers are not quoted; mint failure ships token: null', async () => {
    const anonymous = await quotes.issueQuotes(ranked, ctxFor({ agent: { agent_id: null } }));
    expect(anonymous).toHaveLength(2);
    for (const quote of anonymous) {
      expect(quote.token).toBeNull();
      expect(quote.agent_id).toBeNull();
      expect((await quotes.getQuote(quote.quote_id)).token_jti).toBeNull();
    }

    const displayOnly: RankedOffer = { offer: ranked[0]!.offer, commitment_id: null };
    expect(await quotes.issueQuotes([displayOnly], ctxFor())).toEqual([]);

    const failing = new QuoteService({
      pool,
      tokenClient: { mint: async () => ({ ok: false, error: { code: 'TIMEOUT', message: 'stub' } }) },
    });
    const [unpayable] = await failing.issueQuotes([ranked[0]!], ctxFor());
    expect(unpayable!.token).toBeNull(); // persisted, not dropped
    expect(await quotes.getQuoteStatus(unpayable!.quote_id)).toBe('live');
  });
});
