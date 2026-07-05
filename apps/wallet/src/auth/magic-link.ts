import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId, type Mailer } from '@merited/contracts';
import type pg from 'pg';

/**
 * Magic-link auth (PH1-9, §6.2). Request → a single-use, expiring token is
 * emailed via the `Mailer`; only the token HASH is stored (a DB read never
 * yields a usable link). Verify → the token is looked up by hash, checked
 * unexpired AND unconsumed, marked consumed in the SAME statement (so a
 * concurrent second use loses the race), the consumer is upserted, and a
 * fresh session id is returned. No password anywhere — the email is the
 * factor.
 */
export interface MagicLinkOptions {
  pool: pg.Pool;
  mailer: Mailer;
  clock: { now(): Date };
  /** Base URL the emailed link points at (the wallet UI's verify route). */
  verifyBaseUrl: string;
  /** Link lifetime; default 15 minutes (§6.2). */
  ttlS?: number;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class MagicLinkAuth {
  private readonly ttlS: number;

  constructor(private readonly options: MagicLinkOptions) {
    this.ttlS = options.ttlS ?? 900;
  }

  /** Issue a single-use link to `email` and send it. Returns nothing about
   * the token — the email is the only place it exists (no oracle for whether
   * an address is registered). */
  async request(email: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.options.clock.now().getTime() + this.ttlS * 1000);
    await this.options.pool.query(
      `INSERT INTO wallet.magic_links (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(token), email, expiresAt.toISOString()],
    );
    const link = `${this.options.verifyBaseUrl}?token=${token}`;
    await this.options.mailer.send({
      to: email,
      subject: 'Your Merited sign-in link',
      text: `Sign in to your Merited wallet: ${link}\n\nThis link works once and expires in ${Math.round(this.ttlS / 60)} minutes.`,
    });
  }

  /**
   * Consume a token and return the consumer_ref for a fresh session. null
   * when the token is unknown, expired, or already used — a uniform failure,
   * no reason oracle. Consumption and expiry are checked in one atomic
   * UPDATE so a replay cannot win a race.
   */
  async verify(token: string): Promise<{ consumerRef: string; email: string } | null> {
    const now = this.options.clock.now().toISOString();
    const consumed = await this.options.pool.query<{ email: string }>(
      `UPDATE wallet.magic_links
          SET consumed_at = $2
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING email`,
      [hashToken(token), now],
    );
    const row = consumed.rows[0];
    if (!row) return null;
    // upsert the consumer for this email; stable consumer_ref per address
    const upserted = await this.options.pool.query<{ consumer_ref: string }>(
      `INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING consumer_ref`,
      [newId('usr'), row.email],
    );
    return { consumerRef: upserted.rows[0]!.consumer_ref, email: row.email };
  }
}

/** Constant-time token compare, exported for the session layer's reuse. */
export const timingSafeEqualHex = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};
