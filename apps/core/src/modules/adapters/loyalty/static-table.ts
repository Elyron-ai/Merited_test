import type { LoyaltyLookup } from '@merited/contracts';
import type pg from 'pg';

/**
 * `LoyaltyLookup` over the Phase-0 static membership table (PH1-11): the
 * seeded `core.aurora_club_members` becomes one more impl behind the same
 * interface (the row's "the Ph 0 static membership table becomes one more
 * LoyaltyLookup impl"). Balance lives on the member row; points-credit is
 * idempotent per order via the `core.loyalty_credits` unique key — the
 * insert and the balance bump happen in ONE transaction, so a repeat order
 * never double-credits.
 */
export class StaticTableLoyalty implements LoyaltyLookup {
  constructor(private readonly pool: pg.Pool) {}

  async memberByRef(memberRef: string): Promise<{ tier: string; balance: number } | null> {
    const { rows } = await this.pool.query<{ loyalty_tier: string; points_balance: number }>(
      `SELECT loyalty_tier, points_balance FROM core.aurora_club_members WHERE member_ref = $1`,
      [memberRef],
    );
    const row = rows[0];
    return row ? { tier: row.loyalty_tier, balance: row.points_balance } : null;
  }

  async creditPoints(input: {
    member_ref: string;
    points: number;
    order_ref_hash: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO core.loyalty_credits (order_ref_hash, member_ref, points)
         VALUES ($1, $2, $3) ON CONFLICT (order_ref_hash) DO NOTHING
         RETURNING order_ref_hash`,
        [input.order_ref_hash, input.member_ref, input.points],
      );
      // only bump the balance when this order is NEW (idempotent per order)
      if (inserted.rows.length > 0) {
        await client.query(
          `UPDATE core.aurora_club_members SET points_balance = points_balance + $2
            WHERE member_ref = $1`,
          [input.member_ref, input.points],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
