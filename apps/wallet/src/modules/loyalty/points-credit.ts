import type { LoyaltyLookup } from '@merited/contracts';
import type { DeliveredEvent, Projection } from '@merited/events';
import type pg from 'pg';

/**
 * PH2-10: the loyalty points-credit flow — the PRODUCTION consumer of
 * wallet-path `ConversionVerified` events (the PH1-27 demo drove this by
 * hand; this projection is the standing wiring). Wallet-path means an
 * `apr`-bearing claim: the quote has a recorded Approval, which chains
 * approval → mandate → consumer → their ACTIVE programme links. Walletless
 * claims (`apr: null` — no approval row) credit NOTHING, by construction.
 *
 * Points: one per whole pound of gross value (the Act-2 fixture's 84 points
 * on £84.50), floored — integer arithmetic only.
 *
 * Idempotent per claim at two layers: `wallet.points_credits` is keyed by
 * claim_id and checked BEFORE the adapter call, and the loyalty adapter is
 * itself idempotent per order_ref_hash (PH1-11), so even a crash between
 * credit and record converges on ONE credit when the event replays.
 */

export const pointsForGross = (grossPence: number): number => Math.floor(grossPence / 100);

export interface PointsCreditDeps {
  pool: pg.Pool;
  /** Programme → loyalty API (FakeAurora on the demo path; Eagle Eye AIR is
   * partner-conditional per SYN-31). Null = no adapter → no credit. */
  resolveLoyalty(programme: string): LoyaltyLookup | null;
}

export const pointsCreditProjection = (deps: PointsCreditDeps): Projection => ({
  name: 'wallet_points_credit',
  handles: ['ConversionVerified'],

  async apply(_client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    const data = (event.body as {
      data: {
        claim_id: string;
        qid: string;
        gross_value: { amount: number; currency: 'GBP_pence' };
      };
    }).data;

    // per-claim idempotency gate — a replayed event or rebuild credits once
    const already = await deps.pool.query(
      'SELECT 1 FROM wallet.points_credits WHERE claim_id = $1',
      [data.claim_id],
    );
    if ((already.rowCount ?? 0) > 0) return;

    // wallet-path detection: the approval → mandate → consumer chain. No
    // approval for the quote = walletless claim = nothing to credit.
    const { rows: consumers } = await deps.pool.query<{ consumer_ref: string }>(
      `SELECT m.consumer_ref
         FROM wallet.approvals a JOIN wallet.mandates m ON m.mandate_id = a.mandate_id
        WHERE a.quote_id = $1`,
      [data.qid],
    );
    const consumer = consumers[0];
    if (!consumer) return;

    // the consumer's earliest ACTIVE link takes the credit (one programme
    // per conversion) — a revoked link is revoked consent (B23): no credit
    const { rows: links } = await deps.pool.query<{
      programme: string;
      member_ref: string;
      sub_hash: string;
    }>(
      `SELECT programme, member_ref, sub_hash FROM wallet.identity_links
        WHERE consumer_ref = $1 AND status = 'active'
        ORDER BY linked_at LIMIT 1`,
      [consumer.consumer_ref],
    );
    const link = links[0];
    if (!link) return;
    // OIDC links carry a TOKENISED member handle (mbr_…, B23 — the raw
    // reference never persists); the brand resolves its own members by the
    // privacy handle instead. Hosted links carry the brand's raw ref.
    const creditRef = link.member_ref.startsWith('mbr_') ? link.sub_hash : link.member_ref;

    const adapter = deps.resolveLoyalty(link.programme);
    if (!adapter) return;

    const points = pointsForGross(data.gross_value.amount);
    // ConversionVerified carries no order hash — the claim id IS the stable
    // per-conversion key the adapter's idempotency layer needs
    const orderRefHash = data.claim_id;
    if (points > 0) {
      // credit FIRST, record second: a crash in between replays into the
      // adapter's own order_ref_hash idempotency, never a double credit
      await adapter.creditPoints({
        member_ref: creditRef,
        points,
        order_ref_hash: orderRefHash,
      });
    }
    await deps.pool.query(
      `INSERT INTO wallet.points_credits
         (claim_id, consumer_ref, programme, member_ref, points, order_ref_hash, quote_id, gross_pence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_id) DO NOTHING`,
      [
        data.claim_id,
        consumer.consumer_ref,
        link.programme,
        creditRef,
        points,
        orderRefHash,
        data.qid,
        data.gross_value.amount,
      ],
    );
  },

  // EXECUTION record, not a disposable read model: reset() deliberately
  // keeps the rows — a projection rebuild converges through the per-claim
  // gate + the adapter's order_ref_hash idempotency instead of re-crediting.
  async reset(): Promise<void> {},
});
