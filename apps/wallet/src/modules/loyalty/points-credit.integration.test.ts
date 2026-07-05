import { newId, pence, type LoyaltyLookup } from '@merited/contracts';
import { appendEventInNewTx, catchUp, rebuildProjection } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../scripts/migrate.mjs';
import { pointsCreditProjection, pointsForGross } from './points-credit.js';

/**
 * PH2-10 accept: the points credit is idempotent per claim; walletless
 * (`apr: null`) claims credit nothing. The projection is the production
 * consumer of wallet-path `ConversionVerified`; the `points_credits` rows
 * it writes are the feed wallet screens 1 and 6 render (PH2-3).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_ph210_${Date.now().toString(36)}`;

const CONSUMER = 'usr_00PH210C0NSVMER00000000001';
const MANDATE = 'mnd_00PH210MANDATE000000000001';
const APPROVAL = 'apr_00PH210APPR0VED00000000001';
const WALLET_QID = 'qte_00PH210QV0TE00000000000001';

let admin: pg.Client;
let pool: pg.Pool;

/** Capturing LoyaltyLookup with PH1-11's semantics: idempotent per
 * order_ref_hash — a replayed credit is a no-op, like FakeAurora's API. */
class CapturingLoyalty implements LoyaltyLookup {
  readonly credits: Array<{ member_ref: string; points: number; order_ref_hash: string }> = [];
  private readonly seen = new Set<string>();

  async memberByRef(): Promise<{ tier: string; balance: number } | null> {
    return null;
  }

  async creditPoints(input: { member_ref: string; points: number; order_ref_hash: string }): Promise<void> {
    if (this.seen.has(input.order_ref_hash)) return;
    this.seen.add(input.order_ref_hash);
    this.credits.push(input);
  }
}

const loyalty = new CapturingLoyalty();
const projection = () =>
  pointsCreditProjection({
    pool,
    resolveLoyalty: (programme) => (programme === 'aurora-club' ? loyalty : null),
  });

const verifiedEvent = (qid: string, claimId: string, grossPence: number) => ({
  claim_id: claimId,
  merchant_id: 'mer_00PH210MERCHANT0000000001A',
  jti: newId('atk'),
  qid,
  cid: 'com_00PH210C0MM0TMENT000000001',
  gross_value: pence(grossPence),
  verified_at: '2026-07-05T12:00:00Z',
});

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateWallet(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});

  // the consent chain a wallet-path claim resolves through
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'ph210@example.co.uk')`, [CONSUMER]);
  await pool.query(
    `INSERT INTO wallet.identity_links (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes)
     VALUES ($1, $2, 'mer_00PH210MERCHANT0000000001A', 'aurora-club', 'am_seed_cyn', $3, '["loyalty_ids"]'::jsonb)`,
    [newId('lnk'), CONSUMER, 'p'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO wallet.mandates (mandate_id, consumer_ref, agent_id, scopes, limits, merchants,
                                  data_sharing, pre_authorised_up_to, status, exp, attestation)
     VALUES ($1, $2, $3, '["checkout:execute"]'::jsonb, $4::jsonb, '["*"]'::jsonb,
             $5::jsonb, $6::jsonb, 'active', now() + interval '30 days', 'fake-ed25519:test')`,
    [
      MANDATE,
      CONSUMER,
      newId('agt'),
      JSON.stringify({ per_txn: pence(10000), per_month: pence(50000), categories: [] }),
      JSON.stringify({ email: false, purchase_history: false, loyalty_ids: true }),
      JSON.stringify(pence(2000)),
    ],
  );
  await pool.query(
    `INSERT INTO wallet.approvals (approval_id, mandate_id, quote_id, mode, exp, attestation)
     VALUES ($1, $2, $3, 'explicit', now() + interval '10 minutes', 'fake-ed25519:test')`,
    [APPROVAL, MANDATE, WALLET_QID],
  );
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('PH2-10: loyalty points credit on wallet-path ConversionVerified', () => {
  it('pointsForGross: one point per whole pound, floored, integer in/out', () => {
    expect(pointsForGross(8450)).toBe(84); // the Act-2 fixture
    expect(pointsForGross(99)).toBe(0);
    expect(pointsForGross(100)).toBe(1);
  });

  it('ACCEPT: a wallet-path claim credits via the adapter ONCE, idempotent per claim across replays and rebuilds', async () => {
    const claimId = newId('clm');
    await appendEventInNewTx(pool, 'ConversionVerified', verifiedEvent(WALLET_QID, claimId, 8450));
    await catchUp(pool, projection());

    expect(loyalty.credits).toEqual([
      { member_ref: 'am_seed_cyn', points: 84, order_ref_hash: claimId },
    ]);
    // the screens-1/6 feed row exists
    const { rows } = await pool.query(
      `SELECT consumer_ref, programme, member_ref, points::int FROM wallet.points_credits WHERE claim_id = $1`,
      [claimId],
    );
    expect(rows).toEqual([
      { consumer_ref: CONSUMER, programme: 'aurora-club', member_ref: 'am_seed_cyn', points: 84 },
    ]);

    // a second catch-up and a FULL REBUILD both converge: one credit, ever
    await catchUp(pool, projection());
    const replayed = await rebuildProjection(pool, projection());
    expect(replayed).toBeGreaterThanOrEqual(1);
    expect(loyalty.credits).toHaveLength(1);
    const count = await pool.query(`SELECT count(*)::int AS n FROM wallet.points_credits`);
    expect(count.rows[0]).toEqual({ n: 1 });
  });

  it('ACCEPT: a walletless claim (no approval for the quote) credits NOTHING', async () => {
    const before = loyalty.credits.length;
    await appendEventInNewTx(pool, 'ConversionVerified', verifiedEvent(newId('qte'), newId('clm'), 8450));
    await catchUp(pool, projection());
    expect(loyalty.credits).toHaveLength(before);
    const count = await pool.query(`SELECT count(*)::int AS n FROM wallet.points_credits`);
    expect(count.rows[0]).toEqual({ n: 1 }); // still only the wallet-path row
  });

  it('a REVOKED link is revoked consent: no credit flows through it', async () => {
    await pool.query(`UPDATE wallet.identity_links SET status = 'revoked' WHERE consumer_ref = $1`, [CONSUMER]);
    const qid = newId('qte');
    await pool.query(
      `INSERT INTO wallet.approvals (approval_id, mandate_id, quote_id, mode, exp, attestation)
       VALUES ($1, $2, $3, 'pre_authorised', now() + interval '10 minutes', 'fake-ed25519:test')`,
      [newId('apr'), MANDATE, qid],
    );
    const before = loyalty.credits.length;
    await appendEventInNewTx(pool, 'ConversionVerified', verifiedEvent(qid, newId('clm'), 5000));
    await catchUp(pool, projection());
    expect(loyalty.credits).toHaveLength(before); // consent gone, credit gone
  });
});
