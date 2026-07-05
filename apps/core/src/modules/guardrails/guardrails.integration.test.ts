import {
  newId,
  pence,
  type MerchantCommercial,
  type Offer,
} from '@merited/contracts';
import { appendEventInNewTx, catchUp } from '@merited/events';
import { initOtel, shutdownOtel } from '@merited/otel';
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
import { analyticsProjection } from '../analytics/projections/index.js';
import { PassthroughDecisioner } from '../decisioning/index.js';
import { IdentityStore } from '../identity/store.js';
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { OfferPublisher } from '../offers/publisher.js';
import { ReadOffers } from '../offers/read-offers.js';
import { OffersRepository } from '../offers/repository.js';
import { OffersService } from '../offers/service.js';
import { TrioCommitmentsClient } from '../offers/trio-commitments-client.js';
import { QuoteService } from '../quotes/service.js';
import { TrioTokenClient } from '../token-client/client.js';
import { RuleGuardrails } from './index.js';

/**
 * PH2-1 integration accept (§5.6 verbatim): "budget exhaustion flips reads
 * to `no_offer` with `BUDGET_EXHAUSTED` visible in analytics within one
 * event-projection cycle." Real pipeline, real trio, real ledger, real
 * projection — the only stub is the budget counter override (driving a
 * budget to zero through 100 real conversions proves nothing extra here).
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_gr_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'guardrails-test';
const agentId = newId('agt');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let readOffers: ReadOffers;
/** budget_remaining override per commitment id — simulates burn (SYN-7:
 * the trio stays the source of truth for everything not overridden). */
const budgetOverrides = new Map<string, number>();

let exhaustedMerchant: string;
let marginMerchant: string;
let pacingMerchant: string;
let exhaustedCid: string;
let breachOfferId: string;

const commercial = (guardrails?: MerchantCommercial['guardrails']): MerchantCommercial => ({
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
  ...(guardrails ? { guardrails } : {}),
});

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

beforeAll(async () => {
  initOtel({ serviceName: 'guardrails-test', exporter: 'memory' });
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
    signerSecret: 'guardrails-test-secret',
  });
  const trioUrl = await trio.listen();

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter('guardrails-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  const commitmentsClient = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: commitmentsClient,
    merchantFor: (id) => merchants.get(id),
  });

  const mkOffer = (
    merchantId: string,
    title: string,
    overrides: Partial<Omit<Offer, 'offer_id' | 'status'>> = {},
  ): Omit<Offer, 'offer_id' | 'status'> => ({
    merchant_id: merchantId as `mer_${string}`,
    title,
    description: `${title} — guardrails fixture`,
    mechanics: { type: 'percentage_off', pct_bps: 1500 },
    sku_scope: 'all',
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    valid_from: iso(-3600),
    valid_until: iso(180 * 86400),
    ...overrides,
  });
  const publishOffer = async (draft: Omit<Offer, 'offer_id' | 'status'>) => {
    const created = await offers.createDraft(draft);
    return publisher.publish(created.offer_id, {
      bounty: { type: 'fixed', amount: pence(1200) },
    });
  };

  // merchant 1 — NO guardrail config: proves budget exhaustion is baseline
  const exhausted = await merchants.create({
    name: 'Exhausted Budgets Ltd',
    commercial: commercial(),
  });
  exhaustedMerchant = exhausted.merchant_id;
  const spa = await publishOffer(mkOffer(exhaustedMerchant, 'Spa day'));
  exhaustedCid = spa.commitment_id!;

  // merchant 2 — margin ceiling 2000 bps: 15% passes, 25% breaches
  const margins = await merchants.create({
    name: 'Margin Watchers',
    commercial: commercial({ margin_ceiling_bps: 2000 }),
  });
  marginMerchant = margins.merchant_id;
  await publishOffer(mkOffer(marginMerchant, 'Modest saver'));
  const breach = await publishOffer(
    mkOffer(marginMerchant, 'Deep discount', {
      mechanics: { type: 'percentage_off', pct_bps: 2500 },
    }),
  );
  breachOfferId = breach.offer_id;

  // merchant 3 — pacing: reference £100, threshold 5000 bps; overriding its
  // counters to £10 remaining puts λ ≈ 1000 well below threshold
  const pacing = await merchants.create({
    name: 'Pace Setters',
    commercial: commercial({
      pacing: { reference_budget_pence: 10000, lambda_threshold_bps: 5000 },
    }),
  });
  pacingMerchant = pacing.merchant_id;
  const priced = await publishOffer(mkOffer(pacingMerchant, 'Priced offer'));
  const points = await publishOffer(
    mkOffer(pacingMerchant, 'Points offer', {
      mechanics: { type: 'points_bonus', points: 500 },
    }),
  );
  budgetOverrides.set(priced.commitment_id!, 1000);
  budgetOverrides.set(points.commitment_id!, 1000);

  // the production assembly, exactly as testing.ts wires it — plus the
  // budget override shim in front of the real trio status call
  const listPriceFor = () => pence(10000);
  readOffers = new ReadOffers({
    repository,
    identity: new IdentityStore(pool),
    decisioner: new PassthroughDecisioner(),
    guardrails: new RuleGuardrails(listPriceFor),
    quotes: new QuoteService({
      pool,
      tokenClient: new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    }),
    clock: { now: () => new Date() },
    commitmentStatusFor: async (cid) => {
      const status = await commitmentsClient.status(cid);
      const override = budgetOverrides.get(cid);
      if (status && override !== undefined) {
        return { ...status, budget_remaining: pence(override) };
      }
      return status;
    },
    listPriceFor,
    guardrailSettingsFor: async (merchantId) =>
      (await merchants.get(merchantId).catch(() => null))?.commercial.guardrails ?? null,
    suppressionSink: async (suppressions) => {
      for (const suppression of suppressions) {
        await appendEventInNewTx(pool, 'OfferSuppressed', {
          ...suppression,
          suppressed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        });
      }
    },
  });
}, 120_000);

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('PH2-1 guardrails through the real pipeline', () => {
  it('ACCEPT §5.6 verbatim: budget exhaustion flips reads to no_offer, BUDGET_EXHAUSTED in analytics within ONE projection cycle', async () => {
    // before exhaustion: the offer quotes normally through the same path
    const before = await readOffers.read({
      agent: { agent_id: agentId },
      query: { merchant_id: exhaustedMerchant },
    });
    expect(before.quotes).toHaveLength(1);
    expect(before.quotes[0]!.token).not.toBeNull();

    // burn the budget to zero (counter override — trio still live)
    budgetOverrides.set(exhaustedCid, 0);
    const after = await readOffers.read({
      agent: { agent_id: agentId },
      query: { merchant_id: exhaustedMerchant },
    });
    expect(after.quotes).toEqual([]); // ← no_offer

    // the suppression is a LEDGER fact (SYN-41), carrying merchant + agent
    const { rows: events } = await pool.query(
      `SELECT body->'data' AS data FROM events.events WHERE type = 'OfferSuppressed'
        AND body->'data'->>'merchant_id' = $1`,
      [exhaustedMerchant],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      merchant_id: exhaustedMerchant,
      commitment_id: exhaustedCid,
      reason_code: 'BUDGET_EXHAUSTED',
      agent_id: agentId,
    });

    // …and visible in analytics after exactly ONE projection cycle
    await catchUp(pool, analyticsProjection);
    const { rows } = await pool.query(
      `SELECT reason_code, agent_id, count::int FROM core.rejections_by_reason_day
        WHERE merchant_id = $1`,
      [exhaustedMerchant],
    );
    expect(rows).toEqual([
      { reason_code: 'BUDGET_EXHAUSTED', agent_id: agentId, count: 1 },
    ]);
  });

  it('ACCEPT: margin-floor breach excludes the offer with the reason surfaced', async () => {
    const response = await readOffers.read({
      agent: { agent_id: agentId },
      query: { merchant_id: marginMerchant },
    });
    // 15% offer (1500 bps ≤ 2000) quotes; 25% offer (2500 bps) is gone
    expect(response.quotes).toHaveLength(1);
    expect(response.quotes.map((q) => q.offer_id)).not.toContain(breachOfferId);

    const { rows } = await pool.query(
      `SELECT body->'data'->>'reason_code' AS reason FROM events.events
        WHERE type = 'OfferSuppressed' AND body->'data'->>'offer_id' = $1`,
      [breachOfferId],
    );
    expect(rows).toEqual([{ reason: 'MARGIN_CEILING_EXCEEDED' }]);

    await catchUp(pool, analyticsProjection);
    const { rows: analytics } = await pool.query(
      `SELECT reason_code FROM core.rejections_by_reason_day WHERE merchant_id = $1`,
      [marginMerchant],
    );
    expect(analytics).toEqual([{ reason_code: 'MARGIN_CEILING_EXCEEDED' }]);
  });

  it('ACCEPT: λ below threshold deterministically re-ranks points mechanics first', async () => {
    const read = () =>
      readOffers.read({ agent: { agent_id: agentId }, query: { merchant_id: pacingMerchant } });
    const first = await read();
    // both offers survive (budget 1000 > 0) — nothing suppressed, re-ranked only
    expect(first.quotes).toHaveLength(2);
    // Passthrough decisioning would surface publish order (Priced, Points);
    // low λ flips the points-denominated offer to the front
    const second = await read();
    for (const response of [first, second]) {
      expect(response.quotes.map((q) => q.price.final.amount)).toEqual([
        10000, // points offer: price UNCHANGED — the cheapest currency
        8500, // priced offer: 15% off list 10000
      ]);
    }
    // deterministic across reads: identical order every time
    expect(second.quotes.map((q) => q.offer_id)).toEqual(first.quotes.map((q) => q.offer_id));
  });
});
