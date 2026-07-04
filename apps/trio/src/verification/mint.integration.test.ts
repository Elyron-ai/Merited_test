import { AttributionTokenClaims, FIXTURE_IDS, newId, type CommitmentDraft } from '@merited/contracts';
import { sha256hex } from '@merited/events';
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
import { MintSimulator } from './simulator.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_mint_${Date.now().toString(36)}`;
const signer = new FakeSigner('trio-test-secret');

const draft = (windowS = 86400): CommitmentDraft => ({
  merchant_id: FIXTURE_IDS.merchant,
  offer_ref: FIXTURE_IDS.offer,
  bounty: { type: 'fixed', amount: { amount: 1200, currency: 'GBP_pence' } },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: windowS,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
});

const soonExpiry = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let admin: pg.Client;
let pool: pg.Pool;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let cid: `com_${string}`;

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
  cid = (await commitments.create(draft())).commitment.commitment_id;
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const mintRequest = (overrides: Record<string, unknown> = {}) => ({
  cid,
  qid: newId('qte'),
  aid: FIXTURE_IDS.agent,
  tier: 'T3' as const,
  session_nonce: 'nonce-abc',
  quote: { expires_at: soonExpiry(300), mandate_ref: null },
  ...overrides,
});

describe('Token Mint simulator (TRIO-5 accept)', () => {
  it('mints claims that validate; sid = sha256(nonce); walletless apr null; TokenMinted ledgered', async () => {
    const { token, claims } = await mint.mint(mintRequest());
    expect(() => AttributionTokenClaims.parse(claims)).not.toThrow();
    expect(claims.sid).toBe(sha256hex('nonce-abc'));
    expect(claims.apr).toBeNull();
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(token.startsWith('v4.public.fake.')).toBe(true);

    const { rows } = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'TokenMinted'`,
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('re-mint (B26): same qid, FRESH jti, apr populated; snapshot persists mandate_ref', async () => {
    const first = await mint.mint(mintRequest());
    const apr = FIXTURE_IDS.approval;
    const second = await mint.mint(
      mintRequest({
        qid: first.claims.qid,
        apr,
        quote: { expires_at: soonExpiry(300), mandate_ref: FIXTURE_IDS.mandate },
      }),
    );
    expect(second.claims.qid).toBe(first.claims.qid);
    expect(second.claims.jti).not.toBe(first.claims.jti);
    expect(second.claims.apr).toBe(apr);

    const { rows } = await pool.query(
      'SELECT mandate_ref FROM trio.minted_tokens WHERE jti = $1',
      [second.claims.jti],
    );
    expect(rows[0].mandate_ref).toBe(FIXTURE_IDS.mandate);
  });

  it('token TTL is capped by the attribution window', async () => {
    const shortCid = (await commitments.create(draft(120))).commitment.commitment_id;
    const { claims } = await mint.mint(
      mintRequest({ cid: shortCid, quote: { expires_at: soonExpiry(60), mandate_ref: null } }),
    );
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
  });

  it('rejects a quote snapshot beyond the token exp (422) and a non-live commitment (409)', async () => {
    await expect(
      mint.mint(mintRequest({ quote: { expires_at: soonExpiry(3600), mandate_ref: null } })),
    ).rejects.toMatchObject({ statusCode: 422, code: 'QUOTE_EXPIRY_EXCEEDS_TOKEN' });

    const endedCid = (await commitments.create(draft())).commitment.commitment_id;
    await commitments.end(endedCid, {});
    await expect(mint.mint(mintRequest({ cid: endedCid }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMITMENT_NOT_LIVE',
    });
  });

  it('downstream opacity: the mint response alone carries the claims (token never parsed here)', async () => {
    const { token, claims } = await mint.mint(mintRequest());
    expect(typeof token).toBe('string');
    // deliberate: assertions use `claims` from the response, never decode `token`
    expect(claims.cid).toBe(cid);
  });
});
