import { newId, type DecisionCtx, type EligibleOffer } from '@merited/contracts';
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
import { migrateWallet } from '../../../../wallet/scripts/migrate.mjs';
import { NoopGuardrails } from '../guardrails/index.js';
import { ReadOffers } from '../offers/read-offers.js';
import type { OffersRepository } from '../offers/repository.js';
import type { QuoteService } from '../quotes/service.js';
import { IdentityStore } from './store.js';
import { PgPdReader } from './pd-reader.js';

/**
 * PH2-9 accept: 1pd fields present in DecisionCtx IFF the active mandate's
 * data_sharing flags allow; revocation strips them on the NEXT read (live,
 * no cache); no 1pd value ever appears in the agent-facing response.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_pd9_${Date.now().toString(36)}`;
const coreOnlyDb = `${dbName}_coreonly`;

const CONSUMER = 'usr_00PD9C0NSVMER0000000000001';
const MANDATE = 'mnd_00PD9MANDATE00000000000001';

let admin: pg.Client;
let pool: pg.Pool;
let coreOnlyPool: pg.Pool;

const insertMandate = async (
  id: string,
  dataSharing: Record<string, boolean>,
  status = 'active',
): Promise<void> => {
  await pool.query(
    `INSERT INTO wallet.mandates (mandate_id, consumer_ref, agent_id, scopes, limits, merchants,
                                  data_sharing, pre_authorised_up_to, status, exp, attestation)
     VALUES ($1, $2, $3, '["checkout:execute"]'::jsonb,
             '{"per_txn":{"amount":10000,"currency":"GBP_pence"},"per_month":{"amount":50000,"currency":"GBP_pence"},"categories":[]}'::jsonb,
             '["*"]'::jsonb, $4::jsonb, '{"amount":2000,"currency":"GBP_pence"}'::jsonb,
             $5, now() + interval '30 days', 'fake:pd')`,
    [id, CONSUMER, newId('agt'), JSON.stringify(dataSharing), status],
  );
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await admin.query(`CREATE DATABASE ${coreOnlyDb} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateWallet(adminUrl);
  const coreOnlyAdmin = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${coreOnlyDb}`;
  await migrate(coreOnlyAdmin);
  await migrateCore(coreOnlyAdmin);
  pool = new pg.Pool({ connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`, max: 5 });
  pool.on('error', () => {});
  coreOnlyPool = new pg.Pool({ connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${coreOnlyDb}`, max: 2 });
  coreOnlyPool.on('error', () => {});

  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'pd9@example.co.uk')`, [CONSUMER]);
  await insertMandate(MANDATE, { email: false, purchase_history: true, loyalty_ids: true });
  const put = (key: string, value: string, consented: boolean) =>
    pool.query(
      `INSERT INTO wallet.pd_store (consumer_ref, key, value, consented) VALUES ($1, $2, $3::jsonb, $4)`,
      [CONSUMER, key, JSON.stringify(value), consented],
    );
  await put('email', 'cyn@example.co.uk', true); // flag OFF → never leaves
  await put('loyalty_tier', 'Gold', true);
  await put('purchase_last_category', 'experiences', true);
  await put('purchase_notes', 'private scribbles', false); // UNCONSENTED → never leaves
}, 60_000);

afterAll(async () => {
  await pool.end();
  await coreOnlyPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`DROP DATABASE IF EXISTS ${coreOnlyDb} WITH (FORCE)`);
  await admin.end();
});

describe('PgPdReader (mandate-gated, live)', () => {
  it('ACCEPT: fields present IFF the flags allow; unconsented rows never leave', async () => {
    const pd = await new PgPdReader(pool).pdFor(MANDATE);
    expect(pd).toEqual({ loyalty_tier: 'Gold', purchase_last_category: 'experiences' });
    // email consented but flag false; purchase_notes flagged-in but unconsented
  });

  it('all flags off → nothing; unknown mandate → nothing', async () => {
    const bare = 'mnd_00PD9BAREMANDATE0000000001';
    await insertMandate(bare, { email: false, purchase_history: false, loyalty_ids: false });
    expect(await new PgPdReader(pool).pdFor(bare)).toBeNull();
    expect(await new PgPdReader(pool).pdFor(newId('mnd'))).toBeNull();
  });

  it('ACCEPT: revocation strips on the NEXT read — same reader instance, no cache', async () => {
    const reader = new PgPdReader(pool);
    expect(await reader.pdFor(MANDATE)).not.toBeNull();
    await pool.query(`UPDATE wallet.mandates SET status = 'revoked' WHERE mandate_id = $1`, [MANDATE]);
    expect(await reader.pdFor(MANDATE)).toBeNull(); // the very next read
    await pool.query(`UPDATE wallet.mandates SET status = 'active' WHERE mandate_id = $1`, [MANDATE]);
    expect(await reader.pdFor(MANDATE)).not.toBeNull();
  });

  it('a core-only database probes clean: every read null, no throw', async () => {
    expect(await new PgPdReader(coreOnlyPool).pdFor(MANDATE)).toBeNull();
  });
});

describe('read path: pd into DecisionCtx, never into the response', () => {
  const captured: DecisionCtx[] = [];
  const readOffers = () =>
    new ReadOffers({
      repository: { listCandidates: async () => [] } as unknown as OffersRepository,
      identity: new IdentityStore(pool),
      decisioner: {
        rank: async (eligible: EligibleOffer[], ctx: DecisionCtx) => {
          captured.push(ctx);
          return eligible;
        },
      },
      guardrails: new NoopGuardrails(),
      // empty pipeline → issueQuotes is never consulted beyond the empty list
      quotes: { issueQuotes: async () => [] } as unknown as QuoteService,
      clock: { now: () => new Date() },
      commitmentStatusFor: async () => null,
      listPriceFor: () => ({ amount: 8450, currency: 'GBP_pence' as const }),
      pdReader: new PgPdReader(pool),
    });

  it('ACCEPT: pd rides DecisionCtx with a mandate in consumer_ctx — and the response carries NONE of it', async () => {
    const response = await readOffers().read({
      agent: { agent_id: newId('agt') },
      consumer: { mandate_ref: MANDATE as `mnd_${string}` },
      query: {},
    });
    expect(captured.at(-1)!.pd).toEqual({
      loyalty_tier: 'Gold',
      purchase_last_category: 'experiences',
    });
    const serialised = JSON.stringify(response);
    for (const secret of ['Gold', 'experiences', 'cyn@example.co.uk', 'private scribbles', '"pd"']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('no mandate in ctx → no pd on DecisionCtx', async () => {
    await readOffers().read({ agent: { agent_id: newId('agt') }, query: {} });
    expect(captured.at(-1)!.pd).toBeUndefined();
  });
});
