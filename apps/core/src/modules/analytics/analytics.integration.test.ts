import { newId, pence, type Commitment } from '@merited/contracts';
import { appendEventInNewTx, catchUp, rebuildProjection } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import { analyticsProjection } from './projections/index.js';

/**
 * PH1-19 accept (§5.9): the four analytics projections are ledger-driven and
 * rebuildable from seq 0 — "analytics:rebuild from a wiped projection schema
 * reproduces identical tables" (snapshot → wipe → rebuild → diff = ∅). §5.6
 * downstream accept: BUDGET_EXHAUSTED visible within ONE projection cycle.
 * Reason breakdowns queryable per merchant AND per agent (§3).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_b19_${Date.now().toString(36)}`;

const MERCHANT = 'mer_0000000000000000000000B19A' as const;
const AGENT_A = 'agt_0000000000000000000000B19B' as const;
const AGENT_B = 'agt_0000000000000000000000B19C' as const;
const CID = 'com_0000000000000000000000B19D' as const;

let admin: pg.Client;
let pool: pg.Pool;

const commitment: Commitment = {
  commitment_id: CID,
  merchant_id: MERCHANT,
  offer_ref: 'off_0000000000000000000000B19E',
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
  merchant_sig: 'fake-ed25519:m',
  platform_sig: 'fake-ed25519:p',
};

const tokenClaims = (jti: `atk_${string}`, aid: `agt_${string}`) => ({
  jti,
  cid: CID,
  qid: newId('qte'),
  aid,
  tier: 'T3' as const,
  sid: 'a'.repeat(64),
  apr: null,
  iat: Math.floor(Date.parse('2026-07-05T10:00:00Z') / 1000),
  exp: Math.floor(Date.parse('2026-07-05T10:10:00Z') / 1000),
});

/** Ordered SELECT of every projection table — the snapshot the accept diffs. */
const snapshot = async (): Promise<Record<string, unknown[]>> => {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return {
    conversions: await q(
      'SELECT agent_id, day::text, conversions::int, gross_pence::int FROM core.conversions_by_agent_day ORDER BY agent_id, day',
    ),
    mint_vs_claim: await q(
      'SELECT merchant_id, day::text, mints::int, claims::int, verified::int, rejected::int FROM core.mint_vs_claim_by_merchant_day ORDER BY merchant_id, day',
    ),
    rejections: await q(
      'SELECT day::text, reason_code, merchant_id, agent_id, count::int FROM core.rejections_by_reason_day ORDER BY day, reason_code, merchant_id, agent_id',
    ),
    budget_burn: await q(
      'SELECT commitment_id, merchant_id, day::text, bounty_burned_pence::int FROM core.budget_burn ORDER BY commitment_id, day',
    ),
  };
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});

  // A realistic ledger: 1 commitment, 3 mints (A, A, B), 2 claims, 2 verified
  // (agent A day 1, agent B day 2), 2 rejections (one BUDGET_EXHAUSTED, one
  // with an unparseable token → jti null), 1 reversal of the day-1 conversion.
  const jti1 = newId('atk');
  const jti2 = newId('atk');
  const jti3 = newId('atk');
  const claim1 = newId('clm');
  const claim2 = newId('clm');

  await appendEventInNewTx(pool, 'CommitmentCreated', { commitment });
  await appendEventInNewTx(pool, 'TokenMinted', { claims: tokenClaims(jti1, AGENT_A) });
  await appendEventInNewTx(pool, 'TokenMinted', { claims: tokenClaims(jti2, AGENT_A) });
  await appendEventInNewTx(pool, 'TokenMinted', { claims: tokenClaims(jti3, AGENT_B) });
  await appendEventInNewTx(pool, 'ConversionClaimed', {
    claim_id: claim1, merchant_id: MERCHANT, jti: jti1, qid: newId('qte'), cid: CID,
    order_ref_hash: 'b'.repeat(64), gross_value: pence(8450), ts: '2026-07-05T11:00:00Z',
  });
  await appendEventInNewTx(pool, 'ConversionVerified', {
    claim_id: claim1, merchant_id: MERCHANT, jti: jti1, qid: newId('qte'), cid: CID,
    gross_value: pence(8450), verified_at: '2026-07-05T11:00:01Z',
  });
  await appendEventInNewTx(pool, 'ConversionClaimed', {
    claim_id: claim2, merchant_id: MERCHANT, jti: jti3, qid: newId('qte'), cid: CID,
    order_ref_hash: 'c'.repeat(64), gross_value: pence(5000), ts: '2026-07-06T09:00:00Z',
  });
  await appendEventInNewTx(pool, 'ConversionVerified', {
    claim_id: claim2, merchant_id: MERCHANT, jti: jti3, qid: newId('qte'), cid: CID,
    gross_value: pence(5000), verified_at: '2026-07-06T09:00:01Z',
  });
  await appendEventInNewTx(pool, 'ConversionRejected', {
    claim_id: newId('clm'), merchant_id: MERCHANT, jti: jti2,
    reason_code: 'BUDGET_EXHAUSTED', rejected_at: '2026-07-06T10:00:00Z',
  });
  await appendEventInNewTx(pool, 'ConversionRejected', {
    claim_id: newId('clm'), merchant_id: MERCHANT, jti: null,
    reason_code: 'SIG_INVALID', rejected_at: '2026-07-06T10:05:00Z',
  });
  await appendEventInNewTx(pool, 'ConversionReversed', {
    claim_id: claim1, merchant_id: MERCHANT, reversed_at: '2026-07-07T08:00:00Z',
    reason: 'refund',
  });

  await catchUp(pool, analyticsProjection);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('B19 analytics projections (PH1-19)', () => {
  it('conversions_by_agent_day: per-agent, per-day counts + gross', async () => {
    const { conversions } = await snapshot();
    expect(conversions).toEqual([
      { agent_id: AGENT_A, day: '2026-07-05', conversions: 1, gross_pence: 8450 },
      { agent_id: AGENT_B, day: '2026-07-06', conversions: 1, gross_pence: 5000 },
    ]);
  });

  it('mint_vs_claim_by_merchant_day: the under-reporting monitor feed', async () => {
    const { mint_vs_claim } = await snapshot();
    expect(mint_vs_claim).toEqual([
      { merchant_id: MERCHANT, day: '2026-07-05', mints: 3, claims: 1, verified: 1, rejected: 0 },
      { merchant_id: MERCHANT, day: '2026-07-06', mints: 0, claims: 1, verified: 1, rejected: 2 },
    ]);
  });

  it('rejections_by_reason_day: BUDGET_EXHAUSTED visible, queryable per merchant AND per agent', async () => {
    const { rejections } = await snapshot();
    expect(rejections).toEqual([
      { day: '2026-07-06', reason_code: 'BUDGET_EXHAUSTED', merchant_id: MERCHANT, agent_id: AGENT_A, count: 1 },
      { day: '2026-07-06', reason_code: 'SIG_INVALID', merchant_id: MERCHANT, agent_id: '(unknown)', count: 1 },
    ]);
    // per-agent query works (§3: the agent side sees WHY)
    const byAgent = await pool.query(
      `SELECT reason_code FROM core.rejections_by_reason_day WHERE agent_id = $1`,
      [AGENT_A],
    );
    expect(byAgent.rows).toEqual([{ reason_code: 'BUDGET_EXHAUSTED' }]);
  });

  it('budget_burn: bounty burned per commitment/day; a reversal credits back on ITS day', async () => {
    const { budget_burn } = await snapshot();
    expect(budget_burn).toEqual([
      { commitment_id: CID, merchant_id: MERCHANT, day: '2026-07-05', bounty_burned_pence: 1200 },
      { commitment_id: CID, merchant_id: MERCHANT, day: '2026-07-06', bounty_burned_pence: 1200 },
      { commitment_id: CID, merchant_id: MERCHANT, day: '2026-07-07', bounty_burned_pence: -1200 },
    ]);
  });

  it('ACCEPT §5.9: wipe + rebuild from seq 0 reproduces IDENTICAL tables (diff = ∅)', async () => {
    const before = await snapshot();
    const replayed = await rebuildProjection(pool, analyticsProjection);
    expect(replayed).toBeGreaterThanOrEqual(10); // the full ledger, from seq 0
    const after = await snapshot();
    expect(after).toEqual(before); // diff = ∅
  });

  it('ACCEPT §5.6: a new BUDGET_EXHAUSTED lands within ONE projection cycle', async () => {
    await appendEventInNewTx(pool, 'ConversionRejected', {
      claim_id: newId('clm'), merchant_id: MERCHANT, jti: null,
      reason_code: 'BUDGET_EXHAUSTED', rejected_at: '2026-07-07T12:00:00Z',
    });
    await catchUp(pool, analyticsProjection); // one cycle
    const { rows } = await pool.query(
      `SELECT count::int FROM core.rejections_by_reason_day
        WHERE day = '2026-07-07' AND reason_code = 'BUDGET_EXHAUSTED'`,
    );
    expect(rows).toEqual([{ count: 1 }]);
  });
});
