import type { KeyStore, StoredKeyRecord } from '@merited/signing';
import type pg from 'pg';

/**
 * Postgres-backed KeyStore (PH1-24 over PH1-30's port): `trio.signing_keys`
 * holds only sealed/public material. `putIfAbsent` is race-safe at the
 * database — ON CONFLICT DO NOTHING then re-select, so concurrent first
 * signers for one ref converge on the canonical row. Keys are immutable by
 * grant (the app role has no UPDATE/DELETE).
 */
export class PgKeyStore implements KeyStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(keyRef: string): Promise<StoredKeyRecord | null> {
    const { rows } = await this.pool.query<StoredKeyRecord>(
      `SELECT key_ref, public_key, encrypted_private, encrypted_data_key, iv, auth_tag,
              created_at::text AS created_at
         FROM trio.signing_keys WHERE key_ref = $1`,
      [keyRef],
    );
    return rows[0] ?? null;
  }

  async putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    await this.pool.query(
      `INSERT INTO trio.signing_keys
         (key_ref, public_key, encrypted_private, encrypted_data_key, iv, auth_tag, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key_ref) DO NOTHING`,
      [
        record.key_ref,
        record.public_key,
        record.encrypted_private,
        record.encrypted_data_key,
        record.iv,
        record.auth_tag,
        record.created_at,
      ],
    );
    return (await this.load(record.key_ref))!;
  }
}
