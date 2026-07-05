import type { Money, PayoutRail } from '@merited/contracts';
import type pg from 'pg';
import { loadStripeEnv } from '../../../env.js';
import { SimulatedPayouts } from './simulated.js';

/**
 * StripeConnectPayouts (PH2-6, §2.2): the real `PayoutRail` — Connect
 * accounts per party, one test-mode transfer per net position, reversals
 * for clawbacks. Same interface, same contract suite as SimulatedPayouts
 * (P4: a rail swap is an assembly change). The trio stays payout-ignorant
 * (P3): moving funds is a vendor call, not crypto.
 *
 * Idempotency is delegated to Stripe's own layer: every mutating call
 * carries an `Idempotency-Key` header, so a replayed transfer returns the
 * ORIGINAL transfer object (same `transfer_ref`, no double payout) and a
 * replayed reversal is a no-op. The party→account mapping is pinned in
 * `core.payout_accounts` exactly like the simulated rail's.
 *
 * Plain `fetch` against the versioned REST API — no SDK dependency; the
 * injected `fetchImpl`/`baseUrl` are how CI exercises this adapter without
 * a real key (launch-readiness A7 holds the real test-mode smoke).
 */

const STRIPE_API = 'https://api.stripe.com';
const STRIPE_VERSION = '2024-06-20';

export interface StripeConnectOptions {
  secretKey: string;
  /** Pins one stable account_ref per party (core.payout_accounts). */
  pool: pg.Pool;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Stripe request failed (${status}): ${detail}`);
  }
}

export class StripeConnectPayouts implements PayoutRail {
  constructor(private readonly options: StripeConnectOptions) {}

  private async post(
    path: string,
    body: Record<string, string>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`${this.options.baseUrl ?? STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey,
        'stripe-version': STRIPE_VERSION,
      },
      body: new URLSearchParams(body).toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // surface Stripe's message; NEVER the key (it lives in the header only)
      const detail =
        ((payload['error'] as Record<string, unknown> | undefined)?.['message'] as string) ??
        'no error detail';
      throw new StripeError(response.status, detail);
    }
    return payload;
  }

  async createAccount(party: string): Promise<{ account_ref: string }> {
    const existing = await this.options.pool.query<{ account_ref: string }>(
      'SELECT account_ref FROM core.payout_accounts WHERE party = $1',
      [party],
    );
    if (existing.rows[0]) return { account_ref: existing.rows[0].account_ref };

    // Stripe-side idempotency (`acct/<party>`) makes the create safe even if
    // two workers race past the SELECT — both get the same account back.
    const account = await this.post(
      '/v1/accounts',
      { type: 'express', 'capabilities[transfers][requested]': 'true' },
      `acct/${party}`,
    );
    const accountRef = account['id'] as string;
    await this.options.pool.query(
      `INSERT INTO core.payout_accounts (party, account_ref)
       VALUES ($1, $2) ON CONFLICT (party) DO NOTHING`,
      [party, accountRef],
    );
    const { rows } = await this.options.pool.query<{ account_ref: string }>(
      'SELECT account_ref FROM core.payout_accounts WHERE party = $1',
      [party],
    );
    return { account_ref: rows[0]!.account_ref };
  }

  async transfer(input: {
    account_ref: string;
    amount: Money;
    idempotency_key: string;
  }): Promise<{ transfer_ref: string }> {
    if (!Number.isInteger(input.amount.amount) || input.amount.amount < 0) {
      throw new Error('transfer amount must be non-negative integer pence');
    }
    const transfer = await this.post(
      '/v1/transfers',
      {
        amount: String(input.amount.amount), // integer pence = Stripe minor units
        currency: 'gbp',
        destination: input.account_ref,
      },
      input.idempotency_key,
    );
    return { transfer_ref: transfer['id'] as string };
  }

  async reverse(transferRef: string): Promise<void> {
    // clawback mapping: a Connect transfer reversal; replays converge on the
    // original reversal via the derived idempotency key
    await this.post(
      `/v1/transfers/${encodeURIComponent(transferRef)}/reversals`,
      {},
      `reverse/${transferRef}`,
    );
  }
}

/**
 * The assembly seam (PH2-6): rail selection is CONFIG, not code. A stubbed
 * or absent key keeps Phase-1 behaviour (SimulatedPayouts, statements only);
 * setting `MERITED_STRIPE_SECRET_KEY=sk_test_…` switches the worker to real
 * test-mode Connect transfers; a live key is refused by the env guard until
 * LEAD-2 + LEAD-5 resolve.
 */
export const payoutRailFromEnv = (
  pool: pg.Pool,
  source: Record<string, string | undefined> = process.env,
): PayoutRail => {
  const stripe = loadStripeEnv(source);
  if (stripe.secretKey === null) return new SimulatedPayouts(pool);
  return new StripeConnectPayouts({ secretKey: stripe.secretKey, pool });
};
