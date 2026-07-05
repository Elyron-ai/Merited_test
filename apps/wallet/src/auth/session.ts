import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

/**
 * Wallet sessions (PH1-9). A session id is minted server-side on a verified
 * magic link (fixation impossible — a presented id is never adopted), stored
 * in `wallet.sessions`, and handed to the client as an HMAC-signed cookie.
 * Every request re-validates the ROW (defence in depth), not just the
 * signature.
 */
export const WALLET_SESSION_COOKIE = 'merited_wallet_session';

export interface SessionOptions {
  pool: pg.Pool;
  clock: { now(): Date };
  /** HMAC key for the cookie signature. */
  secret: string;
  ttlS?: number;
}

export class SessionStore {
  private readonly ttlS: number;

  constructor(private readonly options: SessionOptions) {
    this.ttlS = options.ttlS ?? 30 * 24 * 3600; // 30 days
  }

  async mint(consumerRef: string): Promise<string> {
    const sessionId = `sess_${randomBytes(24).toString('base64url')}`;
    const expiresAt = new Date(this.options.clock.now().getTime() + this.ttlS * 1000);
    await this.options.pool.query(
      `INSERT INTO wallet.sessions (session_id, consumer_ref, expires_at) VALUES ($1, $2, $3)`,
      [sessionId, consumerRef, expiresAt.toISOString()],
    );
    return this.sign(sessionId);
  }

  /** Validate a signed cookie value → consumer_ref, or null. */
  async validate(signedCookie: string): Promise<string | null> {
    const sessionId = this.unsign(signedCookie);
    if (!sessionId) return null;
    const { rows } = await this.options.pool.query<{ consumer_ref: string }>(
      `SELECT consumer_ref FROM wallet.sessions WHERE session_id = $1 AND expires_at > $2`,
      [sessionId, this.options.clock.now().toISOString()],
    );
    return rows[0]?.consumer_ref ?? null;
  }

  async destroy(signedCookie: string): Promise<void> {
    const sessionId = this.unsign(signedCookie);
    if (sessionId) {
      await this.options.pool.query(`DELETE FROM wallet.sessions WHERE session_id = $1`, [sessionId]);
    }
  }

  private sign(sessionId: string): string {
    const mac = createHmac('sha256', this.options.secret).update(sessionId).digest('base64url');
    return `${sessionId}.${mac}`;
  }

  private unsign(signedCookie: string): string | null {
    const dot = signedCookie.lastIndexOf('.');
    if (dot < 0) return null;
    const sessionId = signedCookie.slice(0, dot);
    const presented = signedCookie.slice(dot + 1);
    const expected = createHmac('sha256', this.options.secret).update(sessionId).digest('base64url');
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? sessionId : null;
  }
}
