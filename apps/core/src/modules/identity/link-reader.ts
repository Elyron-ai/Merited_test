import type pg from 'pg';

/**
 * A member linked via the wallet's B23 flow (PH1-13/14), as core sees it for
 * identity resolution (PH1-15). The `member_ref` is the TOKENISED handle the
 * link carries (`mbr_…`) — never the raw subject — and `status` is read LIVE
 * so a revocation downgrades the very next resolution (§6.3, ≤5s, no cache).
 */
export interface LinkedMember {
  member_ref: string;
  sub_hash: string;
  consumer_ref: string;
  status: 'active' | 'revoked';
}

/**
 * The seam through which core reads wallet-owned IdentityLinks (PH1-15). In
 * this single-database phase the concrete reader queries `wallet.identity_links`
 * directly for a genuinely live status; a future split-service topology swaps
 * in a ledger-projection-backed reader (fed by AccountLinked/AccountUnlinked)
 * behind this same interface with no change to `resolve`/`IdentityStore`.
 */
export interface IdentityLinkReader {
  linkBy(
    column: 'consumer_ref' | 'sub_hash' | 'member_ref',
    value: string,
  ): Promise<LinkedMember | null>;
}

/**
 * Live reader over `wallet.identity_links`. Tolerates a database migrated with
 * the core schema only (no wallet schema) — `to_regclass` probes for the table
 * once and, when absent, every lookup returns null so the Phase-0 seeded-table
 * fallback stands unchanged. The status is never cached: a revoked link is
 * authoritative on the next read.
 */
export class PgIdentityLinkReader implements IdentityLinkReader {
  private available: boolean | null = null;

  constructor(private readonly pool: pg.Pool) {}

  private async ready(): Promise<boolean> {
    if (this.available === null) {
      const { rows } = await this.pool.query<{ t: string | null }>(
        `SELECT to_regclass('wallet.identity_links') AS t`,
      );
      this.available = rows[0]?.t != null;
    }
    return this.available;
  }

  async linkBy(
    column: 'consumer_ref' | 'sub_hash' | 'member_ref',
    value: string,
  ): Promise<LinkedMember | null> {
    if (!value || !(await this.ready())) return null;
    // `column` is a compile-time union, never caller input — safe to inline.
    const { rows } = await this.pool.query<LinkedMember>(
      `SELECT member_ref, sub_hash, consumer_ref, status
         FROM wallet.identity_links WHERE ${column} = $1
        ORDER BY linked_at DESC LIMIT 1`,
      [value],
    );
    return rows[0] ?? null;
  }
}
