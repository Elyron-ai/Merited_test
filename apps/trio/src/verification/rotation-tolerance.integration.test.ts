import { pence, type CommitmentDraft, type VerifyRequest } from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { Ed25519Signer, InMemoryKms } from '@merited/signing';
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
import { PgKeyStore } from '../shared/pg-key-store.js';
import { FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { claimSignaturePayload, MintSimulator, VerifySimulator } from './simulator.js';

/**
 * PH1-22 accept: "rotation-tolerance contract test green against simulators" —
 * with REAL Ed25519/PASETO crypto over the REAL versioned PgKeyStore: tokens
 * and CORs minted/signed under key N verify after rotation to N+1 with zero
 * change to artefact formats; the compromise path (revoke version N) makes
 * N-signed artefacts fail closed while N+1 is unaffected.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_rot_${Date.now().toString(36)}`;
const ids = seededIdFactory(2207);

let admin: pg.Client;
let pool: pg.Pool;
let signer: Ed25519Signer;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;
let cid: `com_${string}`;
let tokenA: string; // minted under platform/mint v1
let tokenB: string; // minted under platform/mint v1 (the compromise probe)
let mintV1: string; // platform/mint's original key_id

const merchantId = ids.next('mer');
const agentId = ids.next('agt');

const draftFor = (): CommitmentDraft => ({
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
  },
});

const mintOne = async (): Promise<string> =>
  (
    await mint.mint({
      cid,
      qid: ids.next('qte'),
      aid: agentId,
      tier: 'T1',
      session_nonce: `rot-${ids.next('qte')}`,
      quote: { expires_at: new Date(Date.now() + 300_000).toISOString(), mandate_ref: null },
    })
  ).token;

const claimFor = async (token: string): Promise<VerifyRequest> => {
  const base = {
    claim_id: ids.next('clm'),
    merchant_id: merchantId,
    attribution_token: token,
    order: {
      order_ref_hash: 'e'.repeat(64),
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      gross_value: pence(8450),
    },
  };
  const merchant_sig = await signer.sign(`merchant/${merchantId}`, claimSignaturePayload(base));
  return { ...base, merchant_sig } as VerifyRequest;
};

const verify = (claim: VerifyRequest) => verifier.verify(claim, { idempotencyKey: claim.claim_id });

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
  const store = new PgKeyStore(pool); // the REAL versioned store (migration 0004)
  signer = new Ed25519Signer(new InMemoryKms(), store);
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  const keys = new MerchantKeySimulator(deps);
  mint = new MintSimulator(deps, commitments);
  verifier = new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer));

  await keys.issueMerchantKey({ merchant_id: merchantId });
  // key N era: COR signed + two tokens minted, all under the original versions
  cid = (await commitments.create(draftFor())).commitment.commitment_id;
  tokenA = await mintOne(); // creates platform/mint's first version
  tokenB = await mintOne();
  mintV1 = (await store.load('platform/mint'))!.key_id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('rotation tolerance against the simulators (PH1-22 accept)', () => {
  it('ACCEPT: a token + COR from key N verify end-to-end AFTER rotation to N+1 (all three hierarchies)', async () => {
    // rotate every hierarchy the claim path touches
    const rotatedMint = await signer.rotateKey('platform/mint');
    await signer.rotateKey('platform/commitments');
    await signer.rotateKey(`merchant/${merchantId}`);
    expect(rotatedMint.key_id).not.toBe(mintV1);

    // the v1-minted token, claimed against the v1-signed COR, post-rotation:
    const outcome = await verify(await claimFor(tokenA));
    expect(outcome.verdict).toBe('verified');
  });

  it('a token minted AFTER rotation (key N+1) verifies through the same path', async () => {
    const tokenC = await mintOne(); // minted under N+1
    expect(tokenC.startsWith('v4.public.')).toBe(true);
    const outcome = await verify(await claimFor(tokenC));
    expect(outcome.verdict).toBe('verified');
  });

  it('COMPROMISE PATH: revoking mint-key version N kills N-minted tokens; the chain of custody fails closed', async () => {
    expect(await signer.revokeKeyVersion('platform/mint', mintV1)).toBe(true);
    const outcome = await verify(await claimFor(tokenB)); // minted under the revoked version
    expect(outcome.verdict).toBe('rejected');
    if (outcome.verdict !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason_code).toBe('SIG_INVALID');

    // …while the CURRENT version keeps working
    const tokenD = await mintOne();
    expect((await verify(await claimFor(tokenD))).verdict).toBe('verified');
  });
});
