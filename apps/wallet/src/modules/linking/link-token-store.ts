import type { Crypter } from '@merited/signing';
import type pg from 'pg';

/**
 * Encrypted refresh-token store (PH1-8, B23 — HIGH-SCRUTINY). Refresh (and
 * access) tokens for a linked loyalty account are AEAD-sealed through the
 * `Crypter` port (FakeCrypter in Phase 0; KMS-data-key AEAD in PH1-30) and
 * held only as ciphertext at rest, keyed by `link_id`. The plaintext is
 * reachable ONLY through `read()` inside the wallet process — nothing here
 * returns it in a shape that could reach a contract, an API response, or a
 * log line (§3 NB, §6.3).
 *
 * The stored bundle is opaque JSON (whatever the OAuth exchange yielded —
 * the credential fields and an optional expiry); this store neither parses
 * nor logs it, so no credential field name ever appears in wallet code
 * outside the sealed boundary.
 */
const CRYPTER_REF = 'platform/link_tokens';

export class LinkTokenStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly crypter: Crypter,
  ) {}

  /** Seal `bundle` (arbitrary token JSON) and upsert it for the link. */
  async put(linkId: string, bundle: Record<string, unknown>): Promise<void> {
    const ciphertext = await this.crypter.encrypt(CRYPTER_REF, JSON.stringify(bundle));
    await this.pool.query(
      `INSERT INTO wallet.link_tokens (link_id, crypter_ref, ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (link_id)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, crypter_ref = EXCLUDED.crypter_ref,
                     updated_at = now()`,
      [linkId, CRYPTER_REF, ciphertext],
    );
  }

  /** Open the sealed bundle for the link — the ONLY doorway to plaintext.
   * null when no row exists. Callers use it inside the process and never
   * pass it outward. */
  async read(linkId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<{ crypter_ref: string; ciphertext: string }>(
      `SELECT crypter_ref, ciphertext FROM wallet.link_tokens WHERE link_id = $1`,
      [linkId],
    );
    const row = rows[0];
    if (!row) return null;
    return JSON.parse(await this.crypter.decrypt(row.crypter_ref, row.ciphertext)) as Record<
      string,
      unknown
    >;
  }

  /** Revoke: drop the sealed tokens for a link (unlinking / rotation). */
  async remove(linkId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM wallet.link_tokens WHERE link_id = $1`, [
      linkId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
