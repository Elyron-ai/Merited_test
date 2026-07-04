import { existsSync } from 'node:fs';
import {
  FIXTURE_IDS,
  newId,
  pence,
  type CommitmentDraft,
  type VerifyRequest,
} from '@merited/contracts';
import { FakeSigner } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import { CommitmentSimulator } from '../commitment/simulator.js';
import { systemClock } from '../shared/clock.js';
import { merchantKeyRef } from '../shared/deps.js';
import { FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { MintSimulator } from '../verification/simulator.js';
import { claimSignaturePayload, VerifySimulator } from '../verification/verify-pipeline.js';
import { SettlementSimulator } from './simulator.js';
import { monthKey } from './posting.js';
import { renderStatementPdf } from './statements.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_net_${Date.now().toString(36)}`;
const signer = new FakeSigner('trio-test-secret');
// The environment's pre-installed Chromium (falls back to Playwright discovery).
const chromiumPath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const draft = (): CommitmentDraft => ({
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
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
});

let admin: pg.Client;
let pool: pg.Pool;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;
let settlement: SettlementSimulator;

const signedClaim = async (token: string): Promise<VerifyRequest> => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: FIXTURE_IDS.merchant,
    attribution_token: token,
    order: {
      order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      gross_value: pence(8450),
      ts: iso(10),
    },
  };
  const merchant_sig = await signer.sign(
    merchantKeyRef(base.merchant_id),
    claimSignaturePayload(base),
  );
  return { ...base, merchant_sig };
};

const verifiedConversion = async (): Promise<`clm_${string}`> => {
  const cid = (await commitments.create(draft())).commitment.commitment_id;
  const minted = await mint.mint({
    cid,
    qid: newId('qte'),
    aid: FIXTURE_IDS.agent,
    tier: 'T3',
    session_nonce: 'n',
    quote: { expires_at: iso(300), mandate_ref: null },
  });
  const claim = await signedClaim(minted.token);
  const result = await verifier.verify(claim, { idempotencyKey: newId('clm') });
  expect(result.verdict).toBe('verified');
  return claim.claim_id;
};

const signedReverse = async (claimId: `clm_${string}`) => {
  const base = { claim_id: claimId, merchant_id: FIXTURE_IDS.merchant };
  const merchant_sig = await signer.sign(
    merchantKeyRef(base.merchant_id),
    claimSignaturePayload(base),
  );
  return { ...base, merchant_sig };
};

const period = monthKey(new Date());

/** Snapshot normaliser: ULIDs and timestamps out, structure and money in. */
const normalise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, '<ULID>')
      .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<TS>')
      .replace(new RegExp(`"period":"${period}"`, 'g'), '"period":"<PERIOD>"'),
  );

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  mint = new MintSimulator(deps, commitments);
  verifier = new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer));
  settlement = new SettlementSimulator(deps);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('netting, positions, statements (TRIO-11 accept)', () => {
  it('netting run over the Act-1 fixture yields the expected net positions', async () => {
    const claimId = await verifiedConversion();

    const run = await settlement.runNetting({ period });
    expect(run.period).toBe(period);
    expect(run.positions).toEqual([
      { party: FIXTURE_IDS.agent, direction: 'receivable', amount: pence(720) },
      { party: FIXTURE_IDS.merchant, direction: 'payable', amount: pence(1200) },
      { party: 'platform', direction: 'receivable', amount: pence(240) },
      { party: 'reserve', direction: 'receivable', amount: pence(240) },
    ]);

    // Emitted to the hash-chained ledger with the same positions.
    const events = await pool.query(
      `SELECT body->'data' AS data FROM events.events WHERE type = 'SettlementNetted'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data.netting_run_id).toBe(run.netting_run_id);
    expect(events.rows[0].data.positions).toEqual(run.positions);

    // The conversion's set is marked netted (append-only marker, not an edit).
    const marked = await pool.query('SELECT netting_run_id FROM trio.netted_sets WHERE entry_set_id = $1', [
      `set_${claimId}`,
    ]);
    expect(marked.rows).toEqual([{ netting_run_id: run.netting_run_id }]);

    // A second run has nothing un-netted to fold.
    const rerun = await settlement.runNetting({ period });
    expect(rerun.positions).toEqual([]);

    // Reversal of an already-netted conversion posts into the open period:
    // the next run folds exactly the reversing set (mirror-image positions).
    const reversed = await settlement.reverse(await signedReverse(claimId));
    expect(reversed.verdict).toBe('reversed');
    const openPeriodRun = await settlement.runNetting({ period });
    expect(openPeriodRun.positions).toEqual([
      { party: FIXTURE_IDS.agent, direction: 'payable', amount: pence(720) },
      { party: FIXTURE_IDS.merchant, direction: 'receivable', amount: pence(1200) },
      { party: 'platform', direction: 'payable', amount: pence(240) },
      { party: 'reserve', direction: 'payable', amount: pence(240) },
    ]);
  });

  it('positions endpoint agrees with the statement closing balance for every party', async () => {
    await verifiedConversion(); // fresh conversion on top of the netted history
    for (const party of [FIXTURE_IDS.merchant, FIXTURE_IDS.agent, 'platform', 'reserve']) {
      const position = await settlement.position(party);
      const statement = await settlement.statement(party, period);
      expect({ direction: position.direction, amount: position.amount }).toEqual(statement.closing);
    }
    // And the live positions themselves balance: Σ receivable = Σ payable.
    const all = await Promise.all(
      [FIXTURE_IDS.merchant, FIXTURE_IDS.agent, 'platform', 'reserve'].map((p) =>
        settlement.position(p),
      ),
    );
    const signedSum = all.reduce(
      (sum, p) => sum + (p.direction === 'receivable' ? p.amount.amount : -p.amount.amount),
      0,
    );
    expect(signedSum).toBe(0);
  });

  it('statement JSON is snapshot-tested (normalised ids and timestamps)', async () => {
    const statement = await settlement.statement(FIXTURE_IDS.merchant, period);
    expect(normalise(statement)).toMatchSnapshot();
  });

  it('statement PDF renders: exists, non-empty, contains the party name', async () => {
    const statement = await settlement.statement(FIXTURE_IDS.merchant, period);
    const pdf = await renderStatementPdf(statement, chromiumPath ? { executablePath: chromiumPath } : {});
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.toString('latin1')).toContain(FIXTURE_IDS.merchant);
  }, 60000);

  it('rejects a malformed period and unknown parties settle to zero', async () => {
    await expect(settlement.runNetting({ period: '2026-13' })).rejects.toMatchObject({
      code: 'INVALID_PERIOD',
    });
    await expect(settlement.statement('platform', 'nonsense')).rejects.toMatchObject({
      code: 'INVALID_PERIOD',
    });
    expect(await settlement.position('mer_00000000000000000000000000')).toEqual({
      party: 'mer_00000000000000000000000000',
      direction: 'receivable',
      amount: pence(0),
    });
  });

  it('netting tables are append-only at the DB', async () => {
    await expect(
      pool.query(`UPDATE trio.netting_runs SET period = '1999-01'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query(`DELETE FROM trio.netted_sets`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
