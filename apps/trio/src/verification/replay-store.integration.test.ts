import { FIXTURE_IDS, newId, type CommitmentDraft } from '@merited/contracts';
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
import { consumeToken, isConsumed } from './replay-store.js';
import { MintSimulator } from './simulator.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_rpl_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let mint: MintSimulator;
let cid: `com_${string}`;

const soonExpiry = (): string =>
  new Date(Date.now() + 300 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const mintOne = (qid = newId('qte')) =>
  mint.mint({
    cid,
    qid,
    aid: FIXTURE_IDS.agent,
    tier: 'T3',
    session_nonce: 'n',
    quote: { expires_at: soonExpiry(), mandate_ref: null },
  });

const consumeInTx = async (jti: string, qid: string, claimId: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await consumeToken(client, { jti, qid, claim_id: claimId });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    max: 24,
  });
  pool.on('error', () => {});
  const deps = { pool, signer: new FakeSigner('trio-test-secret'), clock: systemClock };
  const commitments = new CommitmentSimulator(deps);
  mint = new MintSimulator(deps, commitments);
  cid = (
    await commitments.create({
      merchant_id: FIXTURE_IDS.merchant,
      offer_ref: FIXTURE_IDS.offer,
      bounty: { type: 'fixed', amount: { amount: 1200, currency: 'GBP_pence' } },
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
    } satisfies CommitmentDraft)
  ).commitment.commitment_id;
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('replay store (TRIO-6 accept — real Postgres, no mocks)', () => {
  it('first consumption succeeds; sequential replay → TOKEN_REPLAYED by jti', async () => {
    const { claims } = await mintOne();
    const first = await consumeInTx(claims.jti, claims.qid, newId('clm'));
    expect(first).toEqual({ consumed: true });
    expect(await isConsumed(pool as unknown as pg.ClientBase, claims.jti)).toBe(true);

    const replay = await consumeInTx(claims.jti, claims.qid, newId('clm'));
    expect(replay).toEqual({ consumed: false, replayed_by: 'jti' });
  });

  it('16 parallel consumptions of one jti → exactly 1 consumed, 15 replayed', async () => {
    const { claims } = await mintOne();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => consumeInTx(claims.jti, claims.qid, newId('clm'))),
    );
    expect(results.filter((r) => r.consumed)).toHaveLength(1);
    expect(results.filter((r) => !r.consumed)).toHaveLength(15);
  });

  it('SYN-9: a re-minted token (same qid, fresh jti) cannot double-convert — replayed by qid', async () => {
    const original = await mintOne();
    const reminted = await mint.mint({
      cid,
      qid: original.claims.qid,
      aid: FIXTURE_IDS.agent,
      tier: 'T3',
      session_nonce: 'n2',
      apr: FIXTURE_IDS.approval,
      quote: { expires_at: soonExpiry(), mandate_ref: FIXTURE_IDS.mandate },
    });
    expect(reminted.claims.jti).not.toBe(original.claims.jti);

    expect(await consumeInTx(original.claims.jti, original.claims.qid, newId('clm'))).toEqual({
      consumed: true,
    });
    expect(await consumeInTx(reminted.claims.jti, reminted.claims.qid, newId('clm'))).toEqual({
      consumed: false,
      replayed_by: 'qid',
    });
  });

  it('a rejected claim never burns the token: rollback leaves it consumable (SYN-9)', async () => {
    const { claims } = await mintOne();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inTxResult = await consumeToken(client, {
        jti: claims.jti,
        qid: claims.qid,
        claim_id: newId('clm'),
      });
      expect(inTxResult).toEqual({ consumed: true });
      await client.query('ROLLBACK'); // later pipeline stage rejected the claim
    } finally {
      client.release();
    }
    expect(await consumeInTx(claims.jti, claims.qid, newId('clm'))).toEqual({ consumed: true });
  });
});
