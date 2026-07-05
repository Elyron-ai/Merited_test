import { pence, type CommitmentDraft, type VerifyRequest } from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { canonicalJson } from '@merited/events';
import { Ed25519Signer, InMemoryKeyStore, InMemoryKms } from '@merited/signing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
import { V4 } from 'paseto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitmentSimulator, MerchantKeySimulator } from '../commitment/simulator.js';
import { systemClock } from '../shared/clock.js';
import { FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { InMemoryReplayCache } from '../shared/replay-cache.js';
import { signServiceToken, verifyServiceToken } from '../shared/service-token.js';
import { claimSignaturePayload, MintSimulator, VerifySimulator } from './simulator.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_paseto_${Date.now().toString(36)}`;
const ids = seededIdFactory(2517);

let admin: pg.Client;
let pool: pg.Pool;
let signer: Ed25519Signer;
let commitments: CommitmentSimulator;
let keys: MerchantKeySimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;
let cache: InMemoryReplayCache;

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

const mintFor = async (cid: `com_${string}`, quoteExpiresInS = 300) =>
  mint.mint({
    cid,
    qid: ids.next('qte'),
    aid: agentId,
    tier: 'T1',
    session_nonce: `nonce-${Math.random()}`,
    quote: {
      expires_at: new Date(Date.now() + quoteExpiresInS * 1000).toISOString(),
      mandate_ref: null,
    },
  });

const claimFor = async (token: string, orderTsOffsetS = 0): Promise<VerifyRequest> => {
  const base = {
    claim_id: ids.next('clm'),
    merchant_id: merchantId,
    attribution_token: token,
    order: {
      order_ref_hash: 'f'.repeat(64),
      ts: new Date(Date.now() + orderTsOffsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
    max: 10,
  });
  pool.on('error', () => {});
  signer = new Ed25519Signer(new InMemoryKms(), new InMemoryKeyStore());
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  keys = new MerchantKeySimulator(deps);
  cache = new InMemoryReplayCache();
  mint = new MintSimulator(deps, commitments);
  verifier = new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer), cache);
  await keys.issueMerchantKey({ merchant_id: merchantId });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('real PASETO mint + verify (PH1-25)', () => {
  it('mints REAL v4.public tokens the paseto library itself verifies; claims echo the response', async () => {
    const cor = await commitments.create(draftFor());
    const minted = await mintFor(cor.commitment.commitment_id);
    expect(minted.token.startsWith('v4.public.')).toBe(true);
    expect(minted.token.startsWith('v4.public.fake.')).toBe(false);
    const payload = await signer.usePublicKey('platform/mint', (publicKey) =>
      V4.verify(minted.token, publicKey),
    );
    expect((payload as { mc: unknown }).mc).toEqual(JSON.parse(canonicalJson(minted.claims)));
  });

  it('a real-token claim verifies end-to-end; the demo negatives reproduce against real PASETO', async () => {
    const cor = await commitments.create(draftFor());
    const minted = await mintFor(cor.commitment.commitment_id);
    const claim = await claimFor(minted.token);
    const verdict = await verifier.verify(claim, { idempotencyKey: `k-${minted.claims.jti}` });
    expect(verdict.verdict).toBe('verified');

    // TOKEN_REPLAYED on the same real token
    const replay = await verifier.verify(await claimFor(minted.token), {
      idempotencyKey: `k-replay-${minted.claims.jti}`,
    });
    expect(replay).toEqual({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });

    // QUOTE_EXPIRED: order timestamped past the minted quote snapshot
    const shortQuote = await mintFor(cor.commitment.commitment_id, 60);
    const lateClaim = await claimFor(shortQuote.token, 120); // 120s > 60s snapshot
    const expired = await verifier.verify(lateClaim, {
      idempotencyKey: `k-expired-${shortQuote.claims.jti}`,
    });
    expect(expired).toEqual({ verdict: 'rejected', reason_code: 'QUOTE_EXPIRED' });
  });

  it('forged and alg-tampered tokens fail closed as SIG_INVALID', async () => {
    const cor = await commitments.create(draftFor());
    const minted = await mintFor(cor.commitment.commitment_id);
    const cases: string[] = [];
    // payload tamper: flip a character in the token body
    const flipAt = 20;
    cases.push(
      minted.token.slice(0, flipAt) +
        (minted.token[flipAt] === 'A' ? 'B' : 'A') +
        minted.token.slice(flipAt + 1),
    );
    // purpose/version confusion: v4.local and v3.public prefixes
    cases.push(minted.token.replace('v4.public.', 'v4.local.'));
    cases.push(minted.token.replace('v4.public.', 'v3.public.'));
    // fake-format token presented to a REAL trio
    cases.push(`v4.public.fake.${Buffer.from(canonicalJson(minted.claims)).toString('base64url')}.fake-ed25519:00`);
    // token signed by the WRONG key (self-minted with a foreign keypair)
    const foreign = new Ed25519Signer(new InMemoryKms(), new InMemoryKeyStore());
    cases.push(
      await foreign.usePrivateKey('platform/mint', (pk) => V4.sign({ mc: minted.claims }, pk, { iat: false })),
    );
    for (const [index, forged] of cases.entries()) {
      const verdict = await verifier.verify(await claimFor(forged), {
        idempotencyKey: `k-forged-${minted.claims.jti}-${index}`,
      });
      expect(verdict, `case ${index}`).toEqual({ verdict: 'rejected', reason_code: 'SIG_INVALID' });
    }
  });

  it('LOAD: 12 concurrent claims on one jti yield exactly one verified', async () => {
    const cor = await commitments.create(draftFor());
    const minted = await mintFor(cor.commitment.commitment_id);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => claimFor(minted.token)),
    );
    const verdicts = await Promise.all(
      claims.map((claim, i) =>
        verifier.verify(claim, { idempotencyKey: `k-load-${minted.claims.jti}-${i}` }),
      ),
    );
    const verified = verdicts.filter((v) => v.verdict === 'verified');
    const replayed = verdicts.filter(
      (v) => v.verdict === 'rejected' && v.reason_code === 'TOKEN_REPLAYED',
    );
    expect(verified).toHaveLength(1);
    expect(replayed).toHaveLength(11);
  });

  it('the replay cache is marked after a verdict and fast-paths the next replay — never authoritative for verified', async () => {
    const cor = await commitments.create(draftFor());
    const minted = await mintFor(cor.commitment.commitment_id);
    expect(await cache.peek(`jti:${minted.claims.jti}`)).toBe(false);
    await verifier.verify(await claimFor(minted.token), {
      idempotencyKey: `k-cache-${minted.claims.jti}`,
    });
    expect(await cache.peek(`jti:${minted.claims.jti}`)).toBe(true); // marked post-commit
    const replay = await verifier.verify(await claimFor(minted.token), {
      idempotencyKey: `k-cache2-${minted.claims.jti}`,
    });
    expect(replay).toEqual({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
  });
});

describe('signed service tokens (PH1-25, arch §6)', () => {
  it('sign → verify round-trips inside the skew window; expired and forged refuse', async () => {
    const token = await signServiceToken(signer, systemClock);
    expect(token.startsWith('svt.v1.')).toBe(true);
    expect(await verifyServiceToken(signer, systemClock, token)).toBe(true);
    // beyond the ±300s window
    const stale = { now: () => new Date(Date.now() + 400_000) };
    expect(await verifyServiceToken(signer, stale, token)).toBe(false);
    // forged: signature by a different key hierarchy/secret
    const foreign = new Ed25519Signer(new InMemoryKms(), new InMemoryKeyStore());
    const forged = await signServiceToken(foreign, systemClock);
    expect(await verifyServiceToken(signer, systemClock, forged)).toBe(false);
    expect(await verifyServiceToken(signer, systemClock, 'svt.v1.garbage')).toBe(false);
  });
});
