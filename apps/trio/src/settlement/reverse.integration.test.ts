import {
  FIXTURE_IDS,
  newId,
  pence,
  type CommitmentDraft,
  type ReverseRequest,
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

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_rev_${Date.now().toString(36)}`;
const signer = new FakeSigner('trio-test-secret');

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const draft = (
  overrides: Partial<CommitmentDraft['terms']> = {},
  extra: Partial<CommitmentDraft> = {},
): CommitmentDraft => ({
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
    ...overrides,
  },
  ...extra,
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

/** Create commitment → mint → verify; returns the ids the reversal needs. */
const verifiedConversion = async (
  overrides: Partial<CommitmentDraft['terms']> = {},
  extra: Partial<CommitmentDraft> = {},
): Promise<{ cid: `com_${string}`; claimId: `clm_${string}` }> => {
  const cid = (await commitments.create(draft(overrides, extra))).commitment.commitment_id;
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
  return { cid, claimId: claim.claim_id };
};

const signedReverse = async (
  claimId: `clm_${string}`,
  opts: { merchantId?: `mer_${string}`; reason?: string } = {},
): Promise<ReverseRequest> => {
  const base = {
    claim_id: claimId,
    merchant_id: opts.merchantId ?? FIXTURE_IDS.merchant,
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  const merchant_sig = await signer.sign(
    merchantKeyRef(base.merchant_id),
    claimSignaturePayload(base),
  );
  return { ...base, merchant_sig };
};

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

describe('clawback reversals (TRIO-10 accept)', () => {
  it('reverse-within-window: balanced reversing set, net effect zero, cap freed, event emitted', async () => {
    const { cid, claimId } = await verifiedConversion({}, { budget: pence(5000) });
    const before = await commitments.status(cid);
    expect(before.conversions_used).toBe(1);
    expect(before.budget_remaining).toEqual(pence(3800));

    const result = await settlement.reverse(await signedReverse(claimId, { reason: 'refunded' }));
    expect(result.verdict).toBe('reversed');
    if (result.verdict !== 'reversed') return;

    // Exact reversal: same accounts and amounts, every side flipped.
    const { rows: originalLines } = await pool.query<{
      account: string;
      side: string;
      amount_pence: string;
    }>(
      `SELECT account, side, amount_pence FROM trio.entry_lines WHERE entry_set_id = $1 ORDER BY line_id`,
      [`set_${claimId}`],
    );
    expect(result.entries_preview.entry_set_id).toBe(`set_rev_${claimId}`);
    expect(result.entries_preview.lines).toEqual(
      originalLines.map((l) => ({
        account: l.account,
        side: l.side === 'dr' ? 'cr' : 'dr',
        amount: pence(Number(l.amount_pence)),
      })),
    );

    // Preview == persisted (the same invariant verify holds to).
    const { rows: persisted } = await pool.query<{
      account: string;
      side: string;
      amount_pence: string;
    }>(
      `SELECT account, side, amount_pence FROM trio.entry_lines WHERE entry_set_id = $1 ORDER BY line_id`,
      [result.entries_preview.entry_set_id],
    );
    expect(persisted).toEqual(
      result.entries_preview.lines.map((l) => ({
        account: l.account,
        side: l.side,
        amount_pence: String(l.amount.amount),
      })),
    );

    // Net effect zero for the conversion: per-account dr − cr sums to 0
    // across the original + reversal sets.
    const { rows: net } = await pool.query<{ account: string; net: string }>(
      `SELECT account,
              SUM(CASE WHEN side = 'dr' THEN amount_pence ELSE -amount_pence END) AS net
         FROM trio.entry_lines
        WHERE entry_set_id IN ($1, $2)
        GROUP BY account`,
      [`set_${claimId}`, `set_rev_${claimId}`],
    );
    expect(net).toHaveLength(4);
    for (const row of net) expect(Number(row.net)).toBe(0);

    // SYN-10: the cap is freed — and ONLY the cap (budget stays spent).
    const after = await commitments.status(cid);
    expect(after.conversions_used).toBe(0);
    expect(after.budget_remaining).toEqual(pence(3800));

    const events = await pool.query(
      `SELECT body->'data'->>'claim_id' AS claim_id, body->'data'->>'reason' AS reason
         FROM events.events WHERE type = 'ConversionReversed'`,
    );
    expect(events.rows).toContainEqual({ claim_id: claimId, reason: 'refunded' });
  });

  it('SYN-10 end-to-end: reversal reopens a CAP_EXHAUSTED commitment', async () => {
    const { cid, claimId } = await verifiedConversion({ max_conversions: 1 });

    const blockedMint = await mint.mint({
      cid,
      qid: newId('qte'),
      aid: FIXTURE_IDS.agent,
      tier: 'T3',
      session_nonce: 'n',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    expect(await verifier.verify(await signedClaim(blockedMint.token), { idempotencyKey: newId('clm') })).toEqual({
      verdict: 'rejected',
      reason_code: 'CAP_EXHAUSTED',
    });

    expect((await settlement.reverse(await signedReverse(claimId))).verdict).toBe('reversed');

    const reopened = await mint.mint({
      cid,
      qid: newId('qte'),
      aid: FIXTURE_IDS.agent,
      tier: 'T3',
      session_nonce: 'n',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    expect(
      (await verifier.verify(await signedClaim(reopened.token), { idempotencyKey: newId('clm') }))
        .verdict,
    ).toBe('verified');
  });

  it('reverse-after-window: rejected with WINDOW_EXPIRED (SYN-10), nothing posted', async () => {
    const { cid, claimId } = await verifiedConversion({ clawback_window_s: 60 });
    const lateSettlement = new SettlementSimulator({
      pool,
      signer,
      clock: { now: () => new Date(Date.now() + 3600_000) },
    });
    expect(await lateSettlement.reverse(await signedReverse(claimId))).toEqual({
      verdict: 'rejected',
      reason_code: 'WINDOW_EXPIRED',
    });
    const sets = await pool.query('SELECT 1 FROM trio.entry_sets WHERE entry_set_id = $1', [
      `set_rev_${claimId}`,
    ]);
    expect(sets.rows).toHaveLength(0);
    expect((await commitments.status(cid)).conversions_used).toBe(1);
  });

  it('double-reverse: rejected with TOKEN_REPLAYED (SYN-35), cap freed exactly once', async () => {
    const { cid, claimId } = await verifiedConversion();
    expect((await settlement.reverse(await signedReverse(claimId))).verdict).toBe('reversed');
    expect(await settlement.reverse(await signedReverse(claimId))).toEqual({
      verdict: 'rejected',
      reason_code: 'TOKEN_REPLAYED',
    });
    expect((await commitments.status(cid)).conversions_used).toBe(0);
    const sets = await pool.query('SELECT count(*) FROM trio.entry_sets WHERE entry_set_id = $1', [
      `set_rev_${claimId}`,
    ]);
    expect(Number(sets.rows[0].count)).toBe(1);
  });

  it('concurrent double-reverse: exactly one wins the entry_sets PK race', async () => {
    const { cid, claimId } = await verifiedConversion();
    const request = await signedReverse(claimId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => settlement.reverse(request)),
    );
    expect(results.filter((r) => r.verdict === 'reversed')).toHaveLength(1);
    expect(
      results.filter((r) => r.verdict === 'rejected' && r.reason_code === 'TOKEN_REPLAYED'),
    ).toHaveLength(7);
    expect((await commitments.status(cid)).conversions_used).toBe(0);
  });

  it('SIG_INVALID: tampered signature; unknown claim; another merchant cannot reverse (SYN-35)', async () => {
    const { claimId } = await verifiedConversion();

    const tampered = await signedReverse(claimId);
    expect(
      await settlement.reverse({ ...tampered, merchant_sig: tampered.merchant_sig.slice(0, -2) + 'ff' }),
    ).toEqual({ verdict: 'rejected', reason_code: 'SIG_INVALID' });

    expect(await settlement.reverse(await signedReverse(newId('clm')))).toEqual({
      verdict: 'rejected',
      reason_code: 'SIG_INVALID',
    });

    // A different merchant signing correctly with their OWN key still cannot
    // reverse someone else's conversion — the COR names the owner.
    expect(
      await settlement.reverse(await signedReverse(claimId, { merchantId: newId('mer') })),
    ).toEqual({ verdict: 'rejected', reason_code: 'SIG_INVALID' });
  });

  it('ledger rows remain append-only: reversal lines reject UPDATE and DELETE at the DB', async () => {
    const { claimId } = await verifiedConversion();
    expect((await settlement.reverse(await signedReverse(claimId))).verdict).toBe('reversed');

    await expect(
      pool.query(`UPDATE trio.entry_lines SET amount_pence = 0 WHERE entry_set_id = $1`, [
        `set_rev_${claimId}`,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query(`DELETE FROM trio.entry_lines WHERE entry_set_id = $1`, [`set_rev_${claimId}`]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
