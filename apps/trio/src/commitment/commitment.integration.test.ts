import { Commitment, FIXTURE_IDS, type CommitmentDraft } from '@merited/contracts';
import { FakeSigner } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import { merchantKeyRef, PLATFORM_COMMITMENT_KEY } from '../shared/deps.js';
import { systemClock } from '../shared/clock.js';
import {
  CommitmentSimulator,
  merchantSignedPayload,
  unsignedCommitmentPayload,
} from './simulator.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_com_${Date.now().toString(36)}`;
const SECRET = 'trio-test-secret';
const signer = new FakeSigner(SECRET);

const draft = (): CommitmentDraft => ({
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
  budget: { amount: 600000, currency: 'GBP_pence' },
});

let admin: pg.Client;
let pool: pg.Pool;
let service: CommitmentSimulator;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl); // events schema (ledger) in the same DB
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  service = new CommitmentSimulator({ pool, signer, clock: systemClock });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('Commitment Signing simulator (TRIO-4 accept)', () => {
  it('creates a COR that validates against Commitment, with both sigs verifying via FakeSigner', async () => {
    const { commitment } = await service.create(draft());
    expect(() => Commitment.parse(commitment)).not.toThrow();
    expect(
      await signer.verify(
        merchantKeyRef(commitment.merchant_id),
        unsignedCommitmentPayload(commitment as never),
        commitment.merchant_sig,
      ),
    ).toBe(true);
    expect(
      await signer.verify(
        PLATFORM_COMMITMENT_KEY,
        merchantSignedPayload(commitment as never),
        commitment.platform_sig,
      ),
    ).toBe(true);
    expect(commitment.merchant_sig.startsWith('fake-ed25519:')).toBe(true);
  });

  it('emits CommitmentCreated into the hash-chained ledger (same transaction)', async () => {
    const { rows } = await pool.query(
      `SELECT body FROM events.events WHERE type = 'CommitmentCreated' ORDER BY seq LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    const body = rows[0].body as { data: { commitment: { commitment_id: string } } };
    expect(body.data.commitment.commitment_id).toMatch(/^com_/);
  });

  it('status: live commitment reports counters and budget', async () => {
    const { commitment } = await service.create(draft());
    const status = await service.status(commitment.commitment_id);
    expect(status).toMatchObject({
      status: 'live',
      conversions_used: 0,
      max_conversions: 500,
      budget_remaining: { amount: 600000, currency: 'GBP_pence' },
    });
  });

  it('end: records termination; ended commitment fails liveness; re-end → 409; CommitmentEnded ledgered', async () => {
    const { commitment } = await service.create(draft());
    const ended = await service.end(commitment.commitment_id, { reason: 'bounty repriced' });
    expect(ended.commitment_id).toBe(commitment.commitment_id);

    expect((await service.status(commitment.commitment_id)).status).toBe('ended');

    await expect(service.end(commitment.commitment_id, {})).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMITMENT_ALREADY_ENDED',
    });

    const { rows } = await pool.query(
      `SELECT count(*) FROM events.events WHERE type = 'CommitmentEnded'`,
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('bounty edit fixture: end COR1, create COR2 — COR1 stays immutable and its sigs still verify (§5.1)', async () => {
    const { commitment: cor1 } = await service.create(draft());
    await service.end(cor1.commitment_id, { reason: 'reprice' });
    const repriced = draft();
    repriced.bounty = { type: 'fixed', amount: { amount: 1500, currency: 'GBP_pence' } };
    const { commitment: cor2 } = await service.create(repriced);

    expect(cor2.commitment_id).not.toBe(cor1.commitment_id);
    const stored1 = await service.load(cor1.commitment_id);
    expect(stored1).toEqual(cor1); // byte-stable — never updated
    expect(
      await signer.verify(
        merchantKeyRef(stored1!.merchant_id),
        unsignedCommitmentPayload(stored1 as never),
        stored1!.merchant_sig,
      ),
    ).toBe(true);
    expect((await service.status(cor2.commitment_id)).status).toBe('live');
  });

  it('status of an unknown commitment → 404', async () => {
    await expect(service.status('com_01J0000000000000000000000Z')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
