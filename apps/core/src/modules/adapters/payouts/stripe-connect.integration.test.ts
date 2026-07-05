import { pence } from '@merited/contracts';
import { appendEventInNewTx, catchUp, rebuildProjection } from '@merited/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../../scripts/migrate.mjs';
import { LiveKeyRefusedError, loadStripeEnv } from '../../../env.js';
import { payoutRailContractSuite } from './contract-test.js';
import { settlementPayoutsProjection, SimulatedPayouts, type StatementsSource } from './simulated.js';
import { StripeConnectPayouts, StripeError, payoutRailFromEnv } from './stripe-connect.js';

/**
 * PH2-6: StripeConnectPayouts behind the SAME `PayoutRail` port and the SAME
 * shared contract suite as SimulatedPayouts. CI runs the adapter against a
 * faithful in-process fake of Stripe's REST semantics (auth, form encoding,
 * Idempotency-Key replay, transfer reversals) — the REAL test-mode smoke
 * needs LEAD-1's keys and is held open in launch-readiness (A7/B1). No key,
 * no network: a real key is an env change, never a code change.
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_ph26_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;

// ── an in-process Stripe (test mode): idempotency-keyed, form-encoded ───────

interface FakeStripe {
  fetchImpl: typeof fetch;
  requests: Array<{ path: string; idempotencyKey: string; body: URLSearchParams }>;
  transferCount(): number;
}

let fakeInstances = 0;

const makeFakeStripe = (): FakeStripe => {
  const instance = (fakeInstances += 1); // distinct id-space per fake, one shared DB
  const accounts = new Set<string>();
  const transfers = new Map<string, { id: string; reversed: boolean }>();
  const byIdempotencyKey = new Map<string, unknown>();
  let seq = 0;
  const requests: FakeStripe['requests'] = [];

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const idempotencyKey = headers.get('idempotency-key') ?? '';
    const body = new URLSearchParams(String(init?.body ?? ''));
    requests.push({ path: url.pathname, idempotencyKey, body });

    if (headers.get('authorization') !== 'Bearer sk_test_fake_key') {
      return json(401, { error: { message: 'Invalid API key provided' } });
    }
    // Stripe idempotency layer: a replayed key returns the ORIGINAL response
    const replayed = byIdempotencyKey.get(idempotencyKey);
    if (replayed !== undefined) return json(200, replayed);

    let result: unknown;
    if (url.pathname === '/v1/accounts') {
      const id = `acct_fake_${instance}_${(seq += 1)}`;
      accounts.add(id);
      result = { id, object: 'account' };
    } else if (url.pathname === '/v1/transfers') {
      const amount = body.get('amount') ?? '';
      if (!/^\d+$/.test(amount)) {
        return json(400, { error: { message: `Invalid integer: ${amount}` } });
      }
      if (body.get('currency') !== 'gbp') {
        return json(400, { error: { message: 'Unsupported currency' } });
      }
      if (!accounts.has(body.get('destination') ?? '')) {
        return json(400, { error: { message: 'No such destination account' } });
      }
      const id = `tr_fake_${instance}_${(seq += 1)}`;
      transfers.set(id, { id, reversed: false });
      result = { id, object: 'transfer', amount: Number(amount) };
    } else {
      const reversal = url.pathname.match(/^\/v1\/transfers\/([^/]+)\/reversals$/);
      if (!reversal) return json(404, { error: { message: `Unknown path ${url.pathname}` } });
      const transfer = transfers.get(reversal[1]!);
      if (!transfer) return json(404, { error: { message: 'No such transfer' } });
      transfer.reversed = true;
      result = { id: `trr_fake_${instance}_${(seq += 1)}`, object: 'transfer_reversal' };
    }
    byIdempotencyKey.set(idempotencyKey, result);
    return json(200, result);
  }) as typeof fetch;

  return { fetchImpl, requests, transferCount: () => transfers.size };
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

// ── ACCEPT: the same adapter contract test as SimulatedPayouts ──────────────

const sharedFake = makeFakeStripe();
payoutRailContractSuite('StripeConnectPayouts (test mode, fake backend)', () =>
  new StripeConnectPayouts({
    secretKey: 'sk_test_fake_key',
    pool,
    baseUrl: 'https://stripe.test.fake',
    fetchImpl: sharedFake.fetchImpl,
  }),
);

describe('env-loader guard (PH2-6 accept: no live key while LEAD-2/LEAD-5 unresolved)', () => {
  it('absent key → SimulatedPayouts stays the rail (Phase-1 behaviour)', () => {
    expect(loadStripeEnv({})).toEqual({ secretKey: null, mode: 'absent' });
    expect(payoutRailFromEnv(pool, {})).toBeInstanceOf(SimulatedPayouts);
  });

  it('a test-mode key selects the Stripe rail', () => {
    const source = { MERITED_STRIPE_SECRET_KEY: 'sk_test_stub_not_a_real_key' };
    expect(loadStripeEnv(source).mode).toBe('test');
    expect(payoutRailFromEnv(pool, source)).toBeInstanceOf(StripeConnectPayouts);
  });

  it('ACCEPT: a LIVE-mode key is REFUSED while LEAD-2/LEAD-5 are unresolved', () => {
    for (const key of ['sk_live_stub_not_a_real_key', 'rk_live_stub_not_a_real_key']) {
      expect(() => loadStripeEnv({ MERITED_STRIPE_SECRET_KEY: key })).toThrow(LiveKeyRefusedError);
      expect(() => payoutRailFromEnv(pool, { MERITED_STRIPE_SECRET_KEY: key })).toThrow(
        /LEAD-2.*LEAD-5|live rails are not approved/i,
      );
    }
  });

  it('a malformed key fails loudly at load, never at transfer time', () => {
    expect(() => loadStripeEnv({ MERITED_STRIPE_SECRET_KEY: 'pk_test_publishable' })).toThrow();
    expect(() => loadStripeEnv({ MERITED_STRIPE_SECRET_KEY: 'hunter2' })).toThrow();
  });
});

describe('Stripe error surface', () => {
  it('a rejected call throws StripeError with Stripe’s message and NO key material', async () => {
    const fake = makeFakeStripe();
    const rail = new StripeConnectPayouts({
      secretKey: 'sk_test_wrong_key',
      pool,
      baseUrl: 'https://stripe.test.fake',
      fetchImpl: fake.fetchImpl,
    });
    const error = await rail.createAccount('agt_error_party').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect((error as StripeError).message).toContain('Invalid API key provided');
    expect((error as StripeError).message).not.toContain('sk_test_wrong_key');
  });
});

// ── ACCEPT (gate clause, CI proxy): netting run → one transfer per position ─

describe('payout worker drives Connect transfers from SettlementNetted', () => {
  const RUN = 'netrun_ph26_0001';
  const PERIOD = '2026-07';
  // D7's numbers to the penny: bounty 1200 → agent 720 / platform 240 /
  // reserve 240; merchant pays the full bounty
  const positions = [
    { party: 'agt_ph26_agent', direction: 'receivable', amount: pence(720) },
    { party: 'mer_ph26_merchant', direction: 'payable', amount: pence(1200) },
    { party: 'platform', direction: 'receivable', amount: pence(240) },
    { party: 'reserve', direction: 'receivable', amount: pence(240) },
  ] as const;

  const statements: StatementsSource = {
    // TRIO-11 resolution stub: every party's statement carries the run's fold
    // with the SAME position (the divergence path is proven in PH1-29's e2e)
    statement: async (party: string) => ({
      netting_events: [
        {
          netting_run_id: RUN,
          position: {
            direction: positions.find((p) => p.party === party)!.direction,
            amount: positions.find((p) => p.party === party)!.amount,
          },
        },
      ],
    }),
  };

  const fake = makeFakeStripe();
  // lazy: `pool` is assigned in beforeAll, after this describe body runs
  const rail = () =>
    new StripeConnectPayouts({
      secretKey: 'sk_test_fake_key',
      pool,
      baseUrl: 'https://stripe.test.fake',
      fetchImpl: fake.fetchImpl,
    });

  it('one test-mode transfer per net position, idempotency key = the netting fold', async () => {
    await appendEventInNewTx(pool, 'SettlementNetted', {
      netting_run_id: RUN,
      period: PERIOD,
      positions: positions.map((p) => ({ ...p, amount: { ...p.amount } })),
    });
    await catchUp(pool, settlementPayoutsProjection(rail(), statements, pool));

    expect(fake.transferCount()).toBe(4);
    const transferCalls = fake.requests.filter((r) => r.path === '/v1/transfers');
    expect(transferCalls.map((r) => r.idempotencyKey).sort()).toEqual(
      positions.map((p) => `${RUN}/${p.party}`).sort(),
    );
    // integer pence straight through as Stripe minor units — no floats anywhere
    expect(
      transferCalls.map((r) => r.body.get('amount')).sort(),
    ).toEqual(['1200', '240', '240', '720']);
    expect(new Set(transferCalls.map((r) => r.body.get('currency')))).toEqual(new Set(['gbp']));

    // the worker leaves the platform's own execution record, enriched
    const { rows } = await pool.query(
      `SELECT transfer_ref, amount_pence::int, direction, netting_run_id, period
         FROM core.payout_statements ORDER BY amount_pence, transfer_ref`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => (r.transfer_ref as string).startsWith('tr_fake_'))).toBe(true);
    expect(rows.every((r) => r.netting_run_id === RUN && r.period === PERIOD)).toBe(true);
  });

  it('a second catch-up moves no money (cursor) and a REBUILD converges on the same transfers (Stripe idempotency)', async () => {
    const before = await pool.query(
      'SELECT transfer_ref FROM core.payout_statements ORDER BY transfer_ref',
    );
    await catchUp(pool, settlementPayoutsProjection(rail(), statements, pool));
    expect(fake.transferCount()).toBe(4); // no new transfers

    const replayed = await rebuildProjection(pool, settlementPayoutsProjection(rail(), statements, pool));
    expect(replayed).toBeGreaterThanOrEqual(1);
    expect(fake.transferCount()).toBe(4); // replayed keys → the ORIGINAL transfers
    const after = await pool.query(
      'SELECT transfer_ref FROM core.payout_statements ORDER BY transfer_ref',
    );
    expect(after.rows).toEqual(before.rows); // no double payout, ever
  });

  it('reverse maps a clawback to a Connect transfer reversal, idempotently', async () => {
    const { rows } = await pool.query<{ transfer_ref: string }>(
      `SELECT transfer_ref FROM core.payout_statements LIMIT 1`,
    );
    const ref = rows[0]!.transfer_ref;
    const stripe = rail();
    await expect(stripe.reverse(ref)).resolves.toBeUndefined();
    await expect(stripe.reverse(ref)).resolves.toBeUndefined(); // replay = no-op
    const reversalCalls = fake.requests.filter((r) => r.path.endsWith('/reversals'));
    expect(reversalCalls).toHaveLength(2);
    expect(new Set(reversalCalls.map((r) => r.idempotencyKey))).toEqual(
      new Set([`reverse/${ref}`]), // both rode the SAME derived key
    );
  });
});
