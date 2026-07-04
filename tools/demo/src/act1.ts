import { existsSync } from 'node:fs';
import {
  AttributionTokenClaims,
  NettingRunResult,
  Statement,
  newId,
  quoteExpiryWithinToken,
  type OfferQuote,
} from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeShop } from '@merited/fake-aurora';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import {
  FakeShopRail,
  PostgresCredentialsStore,
  QuoteClient,
  VerdictPoller,
  searchTermsFrom,
} from '@merited/valet';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../apps/core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../../../apps/valet/scripts/migrate.mjs';
import { runSeed, type SeedResult } from '@merited/seed';
import { AURORA_MERCHANT_ID } from '@merited/seed';
import { runAct, type ActResult, type DemoStep, type RunActOptions } from './harness.js';

/**
 * Act 1, steps 1–7 (VAL-12, §10) — the happy path, mapped one-to-one and
 * every printed number machine-asserted (D7). Runs against the simulators
 * and FakeShop only (§7): the same script is the CI E2E (VAL-14/XC-8).
 */

const SERVICE_TOKEN = 'demo-act1';
const SIGNER_SECRET = 'trio-demo-secret';
const ADMIN = process.env['MERITED_ADMIN_URL'] ?? 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const CHROMIUM = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

const pounds = (pence: number): string =>
  `£${Math.floor(Math.abs(pence) / 100)}.${String(Math.abs(pence) % 100).padStart(2, '0')}`;

interface Act1Flow {
  seed?: SeedResult;
  quote?: OfferQuote;
  claims?: AttributionTokenClaims;
  claimId?: string;
  entries?: { lines: Array<{ account: string; side: 'dr' | 'cr'; amount: { amount: number } }> };
}

export interface Act1Handles {
  pool: pg.Pool;
  appUrl: string;
  trioUrl: string;
  coreUrl: string;
  quotes: QuoteClient;
  rail: () => Promise<FakeShopRail>;
  flow: Act1Flow;
  trioGet(path: string): Promise<Response>;
  trioPost(path: string, body: unknown): Promise<Response>;
}

export const act1Steps = (h: Act1Handles): DemoStep[] => [
  {
    number: 1,
    title: 'Seed Aurora Experiences',
    narrative:
      'Aurora Experiences joins Merited: five Aurora Club members, six offers, and a £12.00 fixed bounty on the full spa day.',
    run: async (ctx) => {
      const seed = await runSeed({
        databaseUrl: h.appUrl,
        serviceToken: SERVICE_TOKEN,
        signerSecret: SIGNER_SECRET,
        log: ctx.mode === 'human' ? ctx.print : () => {},
      });
      h.flow.seed = seed;
      await ctx.artefact('seed.json', JSON.stringify(seed, null, 2));
      return seed;
    },
    assert: (seed) => {
      const s = seed as SeedResult;
      if (s.members !== 5) throw new Error(`expected 5 members, seeded ${s.members}`);
      if (s.offers_published !== 6) throw new Error(`expected 6 offers, published ${s.offers_published}`);
      if (!s.bounty_commitment_id?.startsWith('com_')) throw new Error('bounty COR missing');
    },
  },
  {
    number: 2,
    title: 'The countersigned commitment',
    narrative:
      'The bounty is a Committed Offer Record: Aurora signed it, Merited countersigned it, and it is hashed into the ledger.',
    run: async (ctx) => {
      const { rows } = await h.pool.query(
        `SELECT body->'data'->'commitment' AS commitment FROM events.events WHERE type = 'CommitmentCreated'`,
      );
      const commitment = rows[0]?.commitment as Record<string, unknown>;
      ctx.print(JSON.stringify(commitment, null, 2));
      await ctx.artefact('commitment.json', JSON.stringify(commitment, null, 2));
      return commitment;
    },
    assert: (commitment) => {
      const c = commitment as {
        commitment_id: string;
        bounty: { type: string; amount: { amount: number } };
        take_rate_bps: number;
        agent_commission_bps: number;
        merchant_sig?: string;
        platform_sig?: string;
      };
      if (c.commitment_id !== h.flow.seed!.bounty_commitment_id) throw new Error('COR id mismatch');
      if (c.bounty.type !== 'fixed' || c.bounty.amount.amount !== 1200) throw new Error('bounty is not £12.00 fixed');
      if (c.take_rate_bps !== 2000 || c.agent_commission_bps !== 6000) throw new Error('commercials are not 20%/60%');
      if (!c.merchant_sig || !c.platform_sig) throw new Error('commitment is not countersigned');
    },
  },
  {
    number: 3,
    title: 'Valet reads, Merited quotes',
    narrative:
      'Valet v0 — an ordinary registered agent — self-briefs "spa day under £120". Merited recognises a T3 acquisition read and returns a priced, quote-bound token.',
    run: async (ctx) => {
      await h.quotes.ensureRegistered();
      let quote: OfferQuote | undefined;
      for (const term of searchTermsFrom('spa day under £120')) {
        const read = await h.quotes.readOffers({ text: term }); // no sub_hash: T3
        quote = read.quotes.find((q) => q.token !== null && q.price.final.amount <= 12000);
        if (quote) break;
      }
      if (!quote) throw new Error('no payable quote for the brief');
      h.flow.quote = quote;
      h.flow.claims = AttributionTokenClaims.parse(
        JSON.parse(Buffer.from(quote.token!.split('.')[3]!, 'base64url').toString('utf8')),
      );
      ctx.print(`Quoted ${pounds(quote.price.final.amount)}, expires ${quote.expires_at}`);
      ctx.print(`Token claims: qid ${h.flow.claims.qid} · tier ${h.flow.claims.tier} · apr ${String(h.flow.claims.apr)}`);
      await ctx.artefact('quote.json', JSON.stringify(quote, null, 2));
      await ctx.artefact('token-claims.json', JSON.stringify(h.flow.claims, null, 2));
      return { quote, claims: h.flow.claims };
    },
    assert: () => {
      const { quote, claims } = { quote: h.flow.quote!, claims: h.flow.claims! };
      if (quote.price.final.amount !== 8450) throw new Error(`final price ${quote.price.final.amount} ≠ 8450`);
      if (claims.apr !== null) throw new Error('walletless read must carry apr: null');
      if (claims.tier !== 'T3') throw new Error(`expected T3 acquisition, got ${claims.tier}`);
      if (claims.qid !== quote.quote_id || claims.cid !== quote.commitment_id) throw new Error('token not quote-bound');
      if (!quoteExpiryWithinToken(quote, claims)) throw new Error('quote expiry exceeds token exp');
    },
  },
  {
    number: 4,
    title: 'FakeShop checkout',
    narrative: 'Valet checks out the spa day at FakeShop, carrying the attribution token into the order.',
    run: async (ctx) => {
      const rail = await h.rail();
      const confirmation = await rail.checkout({
        sku: 'sku_spa_day',
        attribution_token: h.flow.quote!.token,
        errand_id: newId('ern'),
      });
      ctx.print(`Order ${confirmation.order_number} confirmed at ${pounds(confirmation.total_pence)} — webhook ${confirmation.webhook}.`);
      await ctx.artefact('order.json', JSON.stringify(confirmation, null, 2));
      return confirmation;
    },
    assert: (confirmation) => {
      const c = confirmation as { total_pence: number; webhook: string };
      if (c.total_pence !== 8450) throw new Error(`order gross ${c.total_pence} ≠ 8450 pence`);
      if (c.webhook !== 'delivered') throw new Error(`webhook ${c.webhook}, expected delivered`);
    },
  },
  {
    number: 5,
    title: 'The claim verifies',
    narrative:
      "Aurora's webhook reached the Grade-B adapter, which built and custody-signed a Conversion Claim. The trio verified it.",
    run: async (ctx) => {
      const poller = new VerdictPoller({ client: h.quotes });
      const verdict = await poller.poll(h.flow.quote!.quote_id);
      if (verdict.type !== 'CLAIM_VERIFIED') throw new Error(`verdict ${JSON.stringify(verdict)}`);
      h.flow.claimId = verdict.claim_id;
      const claim = await h.quotes.getQuoteClaim(h.flow.quote!.quote_id);
      if (claim.entries_preview) h.flow.entries = claim.entries_preview;
      // §7.2 first-failure-wins: a verified verdict IS the proof that every
      // check passed in order — any failure would have surfaced its code.
      for (const check of ['sig chain', 'replay', 'window', 'quote', 'terms']) ctx.print(`  ${check} ✓`);
      await ctx.artefact('verdict.json', JSON.stringify(claim, null, 2));
      return claim;
    },
    assert: (claim) => {
      const c = claim as { claim_id: string; verdict?: string; reason_code?: string; entries_preview?: unknown };
      if (c.verdict !== 'verified') throw new Error(`verdict ${c.verdict} ≠ verified`);
      if (c.reason_code) throw new Error(`unexpected reason_code ${c.reason_code}`);
      if (c.claim_id !== h.flow.claimId) throw new Error('claim id mismatch between poller and status');
      if (!c.entries_preview) throw new Error('verified claim is missing entries_preview');
    },
  },
  {
    number: 6,
    title: 'Balanced ledger entries',
    narrative: 'The £12.00 bounty splits exactly: Aurora pays, the agent earns, Merited takes its cut, the reserve holds the rest.',
    run: async (ctx) => {
      const lines = h.flow.entries!.lines;
      const find = (prefix: string) => lines.find((l) => l.account.startsWith(prefix))!;
      ctx.print(`  merchant −${pounds(find('merchant_payable:').amount.amount)}`);
      ctx.print(`  agent    +${pounds(find('agent_receivable:').amount.amount)}`);
      ctx.print(`  Merited  +${pounds(find('platform_revenue').amount.amount)}`);
      ctx.print(`  reserve  ${pounds(find('reserve:').amount.amount)}`);
      await ctx.artefact('entries.json', JSON.stringify(lines, null, 2));
      return lines;
    },
    assert: (result) => {
      const lines = result as Array<{ account: string; side: 'dr' | 'cr'; amount: { amount: number } }>;
      const amount = (prefix: string) => lines.find((l) => l.account.startsWith(prefix))?.amount.amount;
      if (amount('merchant_payable:') !== 1200) throw new Error('merchant line is not £12.00');
      if (amount('agent_receivable:') !== 720) throw new Error('agent line is not £7.20');
      if (amount('platform_revenue') !== 240) throw new Error('Merited line is not £2.40');
      if (amount('reserve:') !== 240) throw new Error('reserve line is not £2.40');
      const total = (side: 'dr' | 'cr') =>
        lines.filter((l) => l.side === side).reduce((sum, l) => sum + l.amount.amount, 0);
      if (total('dr') !== total('cr')) throw new Error(`trial balance not zero: dr ${total('dr')} ≠ cr ${total('cr')}`);
    },
  },
  {
    number: 7,
    title: 'Netting preview and the statement',
    narrative: "Month end in miniature: the period nets, and Aurora's statement is ready to send.",
    run: async (ctx) => {
      const period = new Date().toISOString().slice(0, 7);
      const netting = NettingRunResult.parse(
        await (await h.trioPost('/trio/netting/run', { period })).json(),
      );
      const statement = Statement.parse(
        await (await h.trioGet(`/trio/statements/${AURORA_MERCHANT_ID}/${period}`)).json(),
      );
      await ctx.artefact('statement-aurora.json', JSON.stringify(statement, null, 2));
      let pdfBytes: Uint8Array | null = null;
      if (CHROMIUM) {
        const pdf = await h.trioGet(`/trio/statements/${AURORA_MERCHANT_ID}/${period}/pdf`);
        pdfBytes = new Uint8Array(await pdf.arrayBuffer());
        const file = await ctx.artefact('statement-aurora.pdf', pdfBytes);
        ctx.print(`Statement PDF written to ${file}.`);
      } else {
        ctx.print('Chromium unavailable — statement captured as JSON only.');
      }
      return { netting, statement, pdfBytes };
    },
    assert: (result) => {
      const r = result as { netting: NettingRunResult; statement: Statement; pdfBytes: Uint8Array | null };
      if (r.statement.party !== AURORA_MERCHANT_ID) throw new Error('statement is not for Aurora');
      if (r.statement.lines.length < 1) throw new Error('statement has no lines');
      if (r.pdfBytes) {
        const magic = Buffer.from(r.pdfBytes.slice(0, 4)).toString('latin1');
        if (magic !== '%PDF') throw new Error(`statement artefact is not a PDF (${magic})`);
      }
    },
  },
];

export interface RunAct1Options extends Partial<Pick<RunActOptions, 'mode' | 'outRoot' | 'print' | 'paceMs'>> {
  /** Keep the throwaway database afterwards (debugging). */
  keepDatabase?: boolean;
}

export const runAct1 = async (options: RunAct1Options = {}): Promise<ActResult> => {
  const dbName = `merited_act1_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateValet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  const pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});

  const trio: SimulatedTrio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
    ...(CHROMIUM ? { chromiumPath: CHROMIUM } : {}),
  });
  const trioUrl = await trio.listen();
  const core: SimulatedCore = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();

  let shop: FastifyInstance | null = null;
  let rail: FakeShopRail | null = null;
  const handles: Act1Handles = {
    pool,
    appUrl,
    trioUrl,
    coreUrl,
    quotes: new QuoteClient({
      baseUrl: coreUrl,
      store: new PostgresCredentialsStore(pool),
      name: 'Valet',
      contact: 'valet@merited.test',
    }),
    rail: async () => {
      if (!rail) {
        const merchant = await core.merchants.get(AURORA_MERCHANT_ID);
        const secret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
        shop = createFakeShop({
          shopDomain: 'aurora.fakeshop.test',
          adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
          webhookSecret: secret,
        });
        const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });
        rail = new FakeShopRail(shopUrl);
      }
      return rail;
    },
    flow: {},
    trioGet: (path) =>
      fetch(`${trioUrl}${path}`, { headers: { 'x-merited-service-token': SERVICE_TOKEN } }),
    trioPost: (path, body) =>
      fetch(`${trioUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-merited-service-token': SERVICE_TOKEN },
        body: JSON.stringify(body),
      }),
  };

  try {
    return await runAct(act1Steps(handles), {
      act: 'act1',
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.outRoot ? { outRoot: options.outRoot } : {}),
      ...(options.print ? { print: options.print } : {}),
      ...(options.paceMs !== undefined ? { paceMs: options.paceMs } : {}),
    });
  } finally {
    if (shop) await (shop as FastifyInstance).close();
    await core.close();
    await trio.close();
    await pool.end();
    if (!options.keepDatabase) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  runAct1({ mode: process.env['MERITED_DEMO_MODE'] === 'ci' ? 'ci' : 'human', paceMs: 600 })
    .then((result) => {
      console.log(`Act 1 complete: ${result.steps} steps, ${result.artefacts.length} artefacts under out/act1/.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
