import { pence, type CommitmentDraft, type VerifyRequest } from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { Ed25519Signer, InMemoryKeyStore, InMemoryKms } from '@merited/signing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitmentSimulator, MerchantKeySimulator } from '../commitment/simulator.js';
import { systemClock } from '../shared/clock.js';
import { FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { claimSignaturePayload, MintSimulator, VerifySimulator } from '../verification/simulator.js';

/**
 * PH1-26 accept: "concurrent verifications never double-spend a cap or
 * budget counter" — under REAL crypto, with DIFFERENT tokens per claim so
 * the jti unique index cannot save us: only the counter lock can.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_counters_${Date.now().toString(36)}`;
const ids = seededIdFactory(1926);

let admin: pg.Client;
let pool: pg.Pool;
let signer: Ed25519Signer;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;

const merchantId = ids.next('mer');
const agentId = ids.next('agt');

const draftFor = (
  overrides: Partial<CommitmentDraft['terms']> = {},
  budget?: ReturnType<typeof pence>,
): CommitmentDraft & { budget?: ReturnType<typeof pence> } => ({
  merchant_id: merchantId,
  offer_ref: ids.next('off'),
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    max_conversions: 500,
    attribution_window_s: 86400,
    clawback_window_s: 2592000,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    valid_from: new Date(Date.now() - 86400_000).toISOString(),
    valid_until: new Date(Date.now() + 180 * 86400_000).toISOString(),
    ...overrides,
  },
  ...(budget ? { budget } : {}),
});

const freshClaim = async (cid: `com_${string}`): Promise<VerifyRequest> => {
  const minted = await mint.mint({
    cid,
    qid: ids.next('qte'),
    aid: agentId,
    tier: 'T1',
    session_nonce: `n-${Math.random()}`,
    quote: { expires_at: new Date(Date.now() + 300_000).toISOString(), mandate_ref: null },
  });
  const base = {
    claim_id: ids.next('clm'),
    merchant_id: merchantId,
    attribution_token: minted.token,
    order: {
      order_ref_hash: 'e'.repeat(64),
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      gross_value: pence(8450),
    },
  };
  const merchant_sig = await signer.sign(`merchant/${merchantId}`, claimSignaturePayload(base));
  return { ...base, merchant_sig } as VerifyRequest;
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
    max: 12,
  });
  pool.on('error', () => {});
  signer = new Ed25519Signer(new InMemoryKms(), new InMemoryKeyStore());
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  mint = new MintSimulator(deps, commitments);
  verifier = new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer));
  await new MerchantKeySimulator(deps).issueMerchantKey({ merchant_id: merchantId });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('counter concurrency (PH1-26)', () => {
  it('a cap-1 commitment under 6 concurrent DIFFERENT-token claims verifies exactly once', async () => {
    const cor = await commitments.create(draftFor({ max_conversions: 1 }));
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => freshClaim(cor.commitment.commitment_id)),
    );
    const verdicts = await Promise.all(
      claims.map((claim) => verifier.verify(claim, { idempotencyKey: claim.claim_id })),
    );
    expect(verdicts.filter((v) => v.verdict === 'verified')).toHaveLength(1);
    expect(
      verdicts.filter((v) => v.verdict === 'rejected' && v.reason_code === 'CAP_EXHAUSTED'),
    ).toHaveLength(5);
    const { rows } = await pool.query(
      `SELECT conversions_used FROM trio.counters WHERE commitment_id = $1`,
      [cor.commitment.commitment_id],
    );
    expect(rows[0]!.conversions_used).toBe(1); // never over-counted
  });

  it('a budget covering exactly one bounty under 4 concurrent claims never double-spends', async () => {
    const cor = await commitments.create(
      draftFor({ max_conversions: null }, pence(1200)),
    );
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => freshClaim(cor.commitment.commitment_id)),
    );
    const verdicts = await Promise.all(
      claims.map((claim) => verifier.verify(claim, { idempotencyKey: claim.claim_id })),
    );
    expect(verdicts.filter((v) => v.verdict === 'verified')).toHaveLength(1);
    expect(
      verdicts.filter((v) => v.verdict === 'rejected' && v.reason_code === 'BUDGET_EXHAUSTED'),
    ).toHaveLength(3);
    const { rows } = await pool.query(
      `SELECT budget_remaining_pence FROM trio.counters WHERE commitment_id = $1`,
      [cor.commitment.commitment_id],
    );
    expect(Number(rows[0]!.budget_remaining_pence)).toBe(0); // spent once, exactly
  });
});
