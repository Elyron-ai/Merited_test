import type pg from 'pg';

/**
 * Consented 1PD store (PH1-9, §6.2). Key-values a consumer chooses to share;
 * READS are mandate-gated — an agent-facing read passes a `consented`
 * requirement, so unconsented values never leave the wallet. The consumer's
 * own wallet session can always read its own data (the `consentedOnly`
 * flag is for the agent/mandate path).
 */
export class PdStore {
  constructor(private readonly pool: pg.Pool) {}

  async put(
    consumerRef: string,
    key: string,
    value: unknown,
    consented: boolean,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet.pd_store (consumer_ref, key, value, consented, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (consumer_ref, key)
       DO UPDATE SET value = EXCLUDED.value, consented = EXCLUDED.consented, updated_at = now()`,
      [consumerRef, key, JSON.stringify(value), consented],
    );
  }

  /** The consumer's own view: every key, consented or not. */
  async list(consumerRef: string): Promise<Array<{ key: string; value: unknown; consented: boolean }>> {
    const { rows } = await this.pool.query<{ key: string; value: unknown; consented: boolean }>(
      `SELECT key, value, consented FROM wallet.pd_store WHERE consumer_ref = $1 ORDER BY key`,
      [consumerRef],
    );
    return rows;
  }

  /** Mandate-gated read: only CONSENTED values, for the agent/decision path. */
  async readConsented(consumerRef: string, key: string): Promise<unknown | null> {
    const { rows } = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM wallet.pd_store WHERE consumer_ref = $1 AND key = $2 AND consented = true`,
      [consumerRef, key],
    );
    return rows[0]?.value ?? null;
  }

  async remove(consumerRef: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM wallet.pd_store WHERE consumer_ref = $1 AND key = $2`,
      [consumerRef, key],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
