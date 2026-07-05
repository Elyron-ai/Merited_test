/**
 * At-rest storage port for envelope-encrypted signing keys (PH1-30; versioned
 * for rotation at PH1-22). Everything in a record is SAFE AT REST — the
 * private key is AEAD-sealed under a KMS data key, and the data key itself is
 * stored only encrypted. The trio wires a Postgres-backed store (PH1-24);
 * tests use `InMemoryKeyStore`.
 *
 * ── Key-id convention (PH1-22, runbook: apps/trio/runbooks/key-rotation.md) ─
 * A key REF (`platform/mint`, `merchant/<id>`, `agent/<id>`) names an
 * identity; a key ID names one VERSION of its keypair —
 * `sha256(public_key_spki)[:12]`, content-derived and stable. Rotation ADDS a
 * version (the new one signs); verification tries every non-revoked version,
 * newest first, so artefacts signed under key N still verify after rotation
 * to N+1 WITHOUT any change to signature or token formats. Revoking a
 * version (the compromise path) makes everything it signed stop verifying.
 */
export interface StoredKeyRecord {
  key_ref: string;
  /** Version id — sha256(public_key)[:12], content-derived (PH1-22). */
  key_id: string;
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
  /** Set on compromise/retirement — a revoked version never verifies again. */
  revoked_at: string | null;
}

export interface KeyStore {
  /** The newest NON-REVOKED version for a ref (the signing key), or null. */
  load(keyRef: string): Promise<StoredKeyRecord | null>;
  /**
   * First writer wins: on a concurrent create for the same ref the store
   * returns the CANONICAL row (the Postgres impl is
   * `ON CONFLICT DO NOTHING` + re-select; callers must adopt the result).
   */
  putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord>;
  /** All non-revoked versions, newest first (verification candidates). */
  loadVersions(keyRef: string): Promise<StoredKeyRecord[]>;
  /** Rotation: ADD a new version; it becomes the signing key. */
  rotate(record: StoredKeyRecord): Promise<StoredKeyRecord>;
  /** Compromise path: revoke ONE version. Idempotent; true when it flipped. */
  revokeVersion(keyRef: string, keyId: string): Promise<boolean>;
}

export class InMemoryKeyStore implements KeyStore {
  /** Versions per ref, newest first. */
  private readonly rows = new Map<string, StoredKeyRecord[]>();

  async load(keyRef: string): Promise<StoredKeyRecord | null> {
    return (await this.loadVersions(keyRef))[0] ?? null;
  }

  async putIfAbsent(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    const existing = await this.load(record.key_ref);
    if (existing) return existing;
    this.rows.set(record.key_ref, [record, ...(this.rows.get(record.key_ref) ?? [])]);
    return record;
  }

  async loadVersions(keyRef: string): Promise<StoredKeyRecord[]> {
    return (this.rows.get(keyRef) ?? []).filter((row) => row.revoked_at === null);
  }

  async rotate(record: StoredKeyRecord): Promise<StoredKeyRecord> {
    this.rows.set(record.key_ref, [record, ...(this.rows.get(record.key_ref) ?? [])]);
    return record;
  }

  async revokeVersion(keyRef: string, keyId: string): Promise<boolean> {
    const versions = this.rows.get(keyRef) ?? [];
    const target = versions.find((row) => row.key_id === keyId && row.revoked_at === null);
    if (!target) return false;
    target.revoked_at = new Date().toISOString();
    return true;
  }
}
