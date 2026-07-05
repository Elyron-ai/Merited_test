/**
 * At-rest storage port for envelope-encrypted signing keys (PH1-30).
 * Everything in a record is SAFE AT REST — the private key is AEAD-sealed
 * under a KMS data key, and the data key itself is stored only encrypted.
 * The trio wires a Postgres-backed store when the real services land
 * (PH1-24); tests use `InMemoryKeyStore`.
 */
export interface StoredKeyRecord {
  key_ref: string;
  /** base64 SPKI DER — public, printable. */
  public_key: string;
  /** base64 — AEAD-sealed PKCS8 private key. */
  encrypted_private: string;
  /** base64 — KMS-encrypted data key (envelope). */
  encrypted_data_key: string;
  /** base64 nonce + tag for the AEAD seal. */
  iv: string;
  auth_tag: string;
  created_at: string;
}

export interface KeyStore {
  load(keyRef: string): Promise<StoredKeyRecord | null>;
  /**
   * First writer wins: on a concurrent create for the same ref the store
   * returns the CANONICAL row (the Postgres impl is
   * `ON CONFLICT DO NOTHING` + re-select; callers must adopt the result).
   */
  putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord>;
}

export class InMemoryKeyStore implements KeyStore {
  private readonly rows = new Map<string, StoredKeyRecord>();

  async load(keyRef: string): Promise<StoredKeyRecord | null> {
    return this.rows.get(keyRef) ?? null;
  }

  async putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    const existing = this.rows.get(record.key_ref);
    if (existing) return existing;
    this.rows.set(record.key_ref, record);
    return record;
  }
}
