import { createHash } from 'node:crypto';
import type { Money, PayoutRail } from '@merited/contracts';
import type { DeliveredEvent, Projection } from '@merited/events';
import type pg from 'pg';

/**
 * SimulatedPayouts (PH1-29, §2.2): the Phase-1 `PayoutRail` BEHAVIOUR — this
 * IS what Phase 1 does, not just a fake. Statements only: a "transfer" writes
 * a payout-statement artefact; money never moves, no live-payment code path
 * exists (§11 — StripeConnectPayouts arrives at PH2-6 behind this same
 * interface and must pass the same contract test in contract-test.ts).
 *
 * Refs are CONTENT-DERIVED so the rail is deterministic and replay-safe:
 * account_ref = simacct_<sha256(party)[:16]>, transfer_ref =
 * simtrf_<sha256(idempotency_key)[:20]> — a replayed transfer converges on
 * the same row (UNIQUE idempotency_key; the insert is ON CONFLICT DO NOTHING).
 */
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class SimulatedPayouts implements PayoutRail {
  constructor(private readonly pool: pg.Pool) {}

  async createAccount(party: string): Promise<{ account_ref: string }> {
    const accountRef = `simacct_${hash(party).slice(0, 16)}`;
    await this.pool.query(
      `INSERT INTO core.payout_accounts (party, account_ref)
       VALUES ($1, $2) ON CONFLICT (party) DO NOTHING`,
      [party, accountRef],
    );
    const { rows } = await this.pool.query<{ account_ref: string }>(
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
    const transferRef = `simtrf_${hash(input.idempotency_key).slice(0, 20)}`;
    await this.pool.query(
      `INSERT INTO core.payout_statements (transfer_ref, account_ref, amount_pence, currency, idempotency_key)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [transferRef, input.account_ref, input.amount.amount, input.amount.currency, input.idempotency_key],
    );
    // replays converge on the ORIGINAL statement (no double payout, ever)
    const { rows } = await this.pool.query<{ transfer_ref: string }>(
      'SELECT transfer_ref FROM core.payout_statements WHERE idempotency_key = $1',
      [input.idempotency_key],
    );
    return { transfer_ref: rows[0]!.transfer_ref };
  }

  async reverse(transferRef: string): Promise<void> {
    // idempotent: a second reverse is a no-op (status already flipped)
    await this.pool.query(
      `UPDATE core.payout_statements SET status = 'reversed', reversed_at = now()
        WHERE transfer_ref = $1 AND status = 'created'`,
      [transferRef],
    );
  }
}

// ── the SettlementNetted → payout-statements driver ─────────────────────────

/** TRIO-11's statements surface (the resolution source). In-process in tests
 * and the monolith; `TrioStatementsClient` is the HTTP wiring. */
export interface StatementsSource {
  statement(party: string, period: string): Promise<{
    netting_events: Array<{
      netting_run_id: string;
      position: { direction: 'payable' | 'receivable'; amount: Money };
    }>;
  }>;
}

export class TrioStatementsClient implements StatementsSource {
  constructor(private readonly options: { baseUrl: string; serviceToken: string; fetchImpl?: typeof fetch }) {}

  async statement(party: string, period: string): Promise<Awaited<ReturnType<StatementsSource['statement']>>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(
      `${this.options.baseUrl}/trio/statements/${encodeURIComponent(party)}/${encodeURIComponent(period)}`,
      { headers: { 'x-merited-service-token': this.options.serviceToken } },
    );
    if (!response.ok) throw new Error(`statement fetch failed: ${response.status}`);
    return (await response.json()) as Awaited<ReturnType<StatementsSource['statement']>>;
  }
}

/**
 * FND-12 projection consuming `SettlementNetted` via the ledger reader: for
 * every party in the run, RESOLVE the position through TRIO-11's statements
 * endpoint (the run's fold must appear there with the SAME position — a
 * divergence fails loudly rather than paying out the wrong number), then
 * produce the payout-statement artefact. idempotency_key =
 * `<netting_run_id>/<party>` so a replayed event or projection rebuild
 * converges on the same artefacts.
 */
export const settlementPayoutsProjection = (
  rail: SimulatedPayouts,
  statements: StatementsSource,
  pool: pg.Pool,
): Projection => ({
  name: 'simulated_payouts',
  handles: ['SettlementNetted'],

  async apply(_client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    const data = (event.body as {
      data: {
        netting_run_id: string;
        period: string;
        positions: Array<{ party: string; direction: 'payable' | 'receivable'; amount: Money }>;
      };
    }).data;

    for (const position of data.positions) {
      // resolve through TRIO-11: the statement must carry this run's fold
      const statement = await statements.statement(position.party, data.period);
      const fold = statement.netting_events.find((e) => e.netting_run_id === data.netting_run_id);
      if (!fold) {
        throw new Error(
          `statement for ${position.party}/${data.period} has no fold for run ${data.netting_run_id}`,
        );
      }
      if (fold.position.amount.amount !== position.amount.amount || fold.position.direction !== position.direction) {
        throw new Error(
          `position divergence for ${position.party}: event says ${position.direction} ${position.amount.amount}, statement says ${fold.position.direction} ${fold.position.amount.amount}`,
        );
      }

      const { account_ref } = await rail.createAccount(position.party);
      const { transfer_ref } = await rail.transfer({
        account_ref,
        amount: position.amount,
        idempotency_key: `${data.netting_run_id}/${position.party}`,
      });
      // enrich the artefact with the fold it came from (driver-level metadata)
      await pool.query(
        `UPDATE core.payout_statements
            SET direction = $2, netting_run_id = $3, period = $4
          WHERE transfer_ref = $1`,
        [transfer_ref, position.direction, data.netting_run_id, data.period],
      );
    }
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.payout_statements');
    await client.query('DELETE FROM core.payout_accounts');
  },
});
