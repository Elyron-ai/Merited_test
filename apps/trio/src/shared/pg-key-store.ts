import type { KeyStore, StoredKeyRecord } from '@merited/signing';
import type pg from 'pg';

/**
 * Postgres-backed KeyStore (PH1-24 over PH1-30's port; versioned for PH1-22
 * rotation): `trio.signing_keys` holds only sealed/public material, one row
 * per key VERSION. `putIfAbsent` is race-safe at the database — ON CONFLICT
 * DO NOTHING then re-select, so concurrent first signers for one ref converge
 * on the canonical row. Sealed material is immutable by grant; the app role
 * may UPDATE `revoked_at` only (the compromise path) — never rewrite keys.
 */
const COLUMNS = `key_ref, key_id, public_key, encrypted_private, encrypted_data_key, iv, auth_tag,
                 created_at::text AS created_at, revoked_at::text AS revoked_at`;

export class PgKeyStore implements KeyStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(keyRef: string): Promise<StoredKeyRecord | null> {
    const { rows } = await this.pool.query<StoredKeyRecord>(
      `SELECT ${COLUMNS} FROM trio.signing_keys
        WHERE key_ref = $1 AND revoked_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [keyRef],
    );
    return rows[0] ?? null;
  }

  async putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    await this.pool.query(
      `INSERT INTO trio.signing_keys
         (key_ref, key_id, public_key, encrypted_private, encrypted_data_key, iv, auth_tag, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key_ref, key_id) DO NOTHING`,
      [
        record.key_ref,
        record.key_id,
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

  async loadVersions(keyRef: string): Promise<StoredKeyRecord[]> {
    const { rows } = await this.pool.query<StoredKeyRecord>(
      `SELECT ${COLUMNS} FROM trio.signing_keys
        WHERE key_ref = $1 AND revoked_at IS NULL
        ORDER BY id DESC`,
      [keyRef],
    );
    return rows;
  }

  async rotate(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    await this.pool.query(
      `INSERT INTO trio.signing_keys
         (key_ref, key_id, public_key, encrypted_private, encrypted_data_key, iv, auth_tag, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.key_ref,
        record.key_id,
        record.public_key,
        record.encrypted_private,
        record.encrypted_data_key,
        record.iv,
        record.auth_tag,
        record.created_at,
      ],
    );
    return record;
  }

  async revokeVersion(keyRef: string, keyId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE trio.signing_keys SET revoked_at = now()
        WHERE key_ref = $1 AND key_id = $2 AND revoked_at IS NULL`,
      [keyRef, keyId],
    );
    return (rowCount ?? 0) > 0;
  }
}
