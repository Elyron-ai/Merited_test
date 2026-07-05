import type pg from 'pg';

/**
 * Mandate-gated 1pd enrichment (PH2-9, arch §4.1: "the one input
 * merchant-side Talon.One structurally cannot have"). The read path hands
 * this the mandate ref from consumer_ctx; consented pd key-values come back
 * ONLY where the ACTIVE mandate's data_sharing flags allow, read LIVE per
 * request — a revocation strips them on the very next read, no cache.
 *
 * Flag → key mapping (the wallet's pd_store is free-form key-values):
 *   email             → the 'email' key
 *   purchase_history  → keys prefixed 'purchase_'
 *   loyalty_ids       → keys prefixed 'loyalty_'
 * Unconsented rows never leave regardless of flags (`consented = true` in
 * the WHERE — the pd-store's own discipline, PH1-9).
 */
export interface PdReader {
  pdFor(mandateRef: string): Promise<Record<string, string> | null>;
}

interface DataSharing {
  email?: boolean;
  purchase_history?: boolean;
  loyalty_ids?: boolean;
}

const allowed = (key: string, flags: DataSharing): boolean =>
  (key === 'email' && flags.email === true) ||
  (key.startsWith('purchase_') && flags.purchase_history === true) ||
  (key.startsWith('loyalty_') && flags.loyalty_ids === true);

/** Tolerates a core-only database (no wallet schema): `to_regclass` probes
 * once and, when absent, every read returns null — Phase-0 assemblies are
 * unchanged (the PgIdentityLinkReader pattern). */
export class PgPdReader implements PdReader {
  private available: boolean | null = null;

  constructor(private readonly pool: pg.Pool) {}

  private async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    const { rows } = await this.pool.query<{ mandates: string | null; pd: string | null }>(
      `SELECT to_regclass('wallet.mandates')::text AS mandates,
              to_regclass('wallet.pd_store')::text AS pd`,
    );
    this.available = rows[0]?.mandates !== null && rows[0]?.pd !== null;
    return this.available;
  }

  async pdFor(mandateRef: string): Promise<Record<string, string> | null> {
    if (!(await this.probe())) return null;

    // LIVE mandate check: revoked or expired → nothing, on THIS read
    const { rows: mandates } = await this.pool.query<{
      consumer_ref: string;
      data_sharing: DataSharing;
    }>(
      `SELECT consumer_ref, data_sharing FROM wallet.mandates
        WHERE mandate_id = $1 AND status = 'active' AND exp > now()`,
      [mandateRef],
    );
    const mandate = mandates[0];
    if (!mandate) return null;

    const { rows: items } = await this.pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM wallet.pd_store
        WHERE consumer_ref = $1 AND consented = true ORDER BY key`,
      [mandate.consumer_ref],
    );
    const pd: Record<string, string> = {};
    for (const item of items) {
      if (!allowed(item.key, mandate.data_sharing)) continue;
      pd[item.key] = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
    }
    return Object.keys(pd).length > 0 ? pd : null;
  }
}
