import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_IDS, newId, pence, type CommitmentDraft } from '@merited/contracts';
import { canonicalJson, catchUp, rebuildProjection } from '@merited/events';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { FakeSigner } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../../trio/scripts/migrate.mjs';
import { TrioCommitmentsClient } from '../../offers/trio-commitments-client.js';
import { TrioTokenClient } from '../../token-client/client.js';
import { payoutRailContractSuite } from './contract-test.js';
import { settlementPayoutsProjection, SimulatedPayouts, TrioStatementsClient } from './simulated.js';

/**
 * PH1-29 accept: netting run → statement artefacts with ZERO external calls
 * (the trio is internal; no PSP exists); the shared adapter contract test
 * passes (PH2-6 imports the same suite); no live-payment code path (§11).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_b29_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'b29-service-token';
const signer = new FakeSigner('b29-test-secret');
const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let rail: SimulatedPayouts;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  await migrateCore(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: 'b29-test-secret' });
  trioUrl = await trio.listen();

  // one verified conversion (bounty 1200 → agent 720 / platform 240 /
  // reserve 240 / merchant payable 1200), then netting emits SettlementNetted
  const commitments = new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const tokens = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  const draft: CommitmentDraft = {
    merchant_id: FIXTURE_IDS.merchant,
    offer_ref: FIXTURE_IDS.offer,
    bounty: { type: 'fixed', amount: pence(1200) },
    take_rate_bps: 2000,
    agent_commission_bps: 6000,
    terms: {
      attribution_window_s: 86400,
      eligible_identity_tiers: ['T1', 'T2', 'T3'],
      max_conversions: 500,
      clawback_window_s: 2592000,
      valid_from: iso(-86400),
      valid_until: iso(180 * 86400),
    },
  };
  const cid = (await commitments.create(draft)).commitment_id;
  const minted = await tokens.mint({
    cid,
    qid: newId('qte'),
    aid: FIXTURE_IDS.agent,
    tier: 'T3',
    session_nonce: 'b29',
    quote: { expires_at: iso(300), mandate_ref: null },
  });
  if (!minted.ok) throw new Error('setup mint failed');
  const base = {
    claim_id: newId('clm'),
    merchant_id: FIXTURE_IDS.merchant,
    attribution_token: minted.minted.token,
    order: { order_ref_hash: 'a'.repeat(64), gross_value: pence(8450), ts: iso(5) },
  };
  const merchant_sig = await signer.sign(`merchant/${base.merchant_id}`, canonicalJson(base));
  const verdictResponse = await fetch(`${trioUrl}/trio/claims/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-merited-service-token': SERVICE_TOKEN,
      'idempotency-key': base.claim_id,
    },
    body: JSON.stringify({ ...base, merchant_sig }),
  });
  const verdict = (await verdictResponse.json()) as { verdict: string };
  if (verdict.verdict !== 'verified') throw new Error(`setup claim rejected: ${JSON.stringify(verdict)}`);

  rail = new SimulatedPayouts(pool);
}, 60_000);

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

// ── the shared adapter contract suite (PH2-6 imports this same function) ────
payoutRailContractSuite('SimulatedPayouts', () => rail);

describe('SimulatedPayouts — netting → statement artefacts (PH1-29)', () => {
  it('a netting run produces one payout-statement artefact per party, resolved via TRIO-11 statements — money never moves', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const runResponse = await fetch(`${trioUrl}/trio/netting/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-merited-service-token': SERVICE_TOKEN },
      body: JSON.stringify({ period }),
    });
    const run = (await runResponse.json()) as { netting_run_id: string };

    // consume SettlementNetted via the ledger reader; resolve positions
    // through TRIO-11's statements endpoint (HTTP — the production wiring)
    const projection = settlementPayoutsProjection(
      rail,
      new TrioStatementsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
      pool,
    );
    await catchUp(pool, projection);

    const { rows } = await pool.query<{
      party: string; direction: string; amount_pence: string; netting_run_id: string; period: string; status: string;
    }>(
      `SELECT a.party, s.direction, s.amount_pence, s.netting_run_id, s.period, s.status
         FROM core.payout_statements s JOIN core.payout_accounts a ON a.account_ref = s.account_ref
        WHERE s.netting_run_id = $1
        ORDER BY a.party`,
      [run.netting_run_id],
    );
    expect(rows.map((r) => ({ ...r, amount_pence: Number(r.amount_pence) }))).toEqual([
      { party: FIXTURE_IDS.agent, direction: 'receivable', amount_pence: 720, netting_run_id: run.netting_run_id, period, status: 'created' },
      { party: FIXTURE_IDS.merchant, direction: 'payable', amount_pence: 1200, netting_run_id: run.netting_run_id, period, status: 'created' },
      { party: 'platform', direction: 'receivable', amount_pence: 240, netting_run_id: run.netting_run_id, period, status: 'created' },
      { party: 'reserve', direction: 'receivable', amount_pence: 240, netting_run_id: run.netting_run_id, period, status: 'created' },
    ]);

    // replaying the ledger converges on the SAME artefacts (idempotent keys)
    await catchUp(pool, projection);
    const recount = await pool.query(`SELECT count(*)::int AS n FROM core.payout_statements WHERE netting_run_id = $1`, [run.netting_run_id]);
    expect((recount.rows[0] as { n: number }).n).toBe(4);

    // …and a full wipe+rebuild reproduces them (projections stay disposable)
    const rebuilt = await rebuildProjection(pool, projection);
    expect(rebuilt).toBeGreaterThan(0);
    const after = await pool.query(`SELECT count(*)::int AS n FROM core.payout_statements WHERE netting_run_id = $1`, [run.netting_run_id]);
    expect((after.rows[0] as { n: number }).n).toBe(4);
  });

  it('§11: no live-payment code path exists — the payouts module knows no PSP and dials no external host', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(dir, 'simulated.ts'), 'utf8');
    // no PSP SDK import, no external URL — TrioStatementsClient's fetch
    // targets the INTERNAL trio surface only (doc comments may NAME Stripe;
    // the code path must not touch it)
    expect(source).not.toMatch(/from ['"]stripe/i);
    expect(source).not.toMatch(/require\(['"]stripe/i);
    expect(source).not.toMatch(/api\.[a-z]+\.com/i);
    expect(source).not.toMatch(/https:\/\//);
  });
});
