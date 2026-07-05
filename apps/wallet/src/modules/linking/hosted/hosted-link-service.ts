import { createHash, randomBytes } from 'node:crypto';
import { type IdentityLink, type LoyaltyLookup, type Mailer } from '@merited/contracts';
import type pg from 'pg';
import { buildIdentityLink, persistLink } from '../link-writer.js';

/**
 * Hosted-linking fallback (PH1-14, B23) for IdP-less programmes. There is no
 * OAuth here: the consumer enters their member number and an email, we confirm
 * the number against the brand's own loyalty API, and we email a single-use
 * verification token. Redeeming that token proves control of the email and
 * completes the SAME `IdentityLink` the OAuth path produces (§6.3; the
 * derivation is shared via `link-writer`).
 *
 * This is deliberately a verification-EMAIL loop, NOT credential capture — the
 * safe default named in architecture §8/Q7. No password or brand credential is
 * ever accepted or stored; the request schema has no field for one, and the
 * email is the only factor. Only the token HASH is persisted, and an attempt
 * row is written ONLY when the member number is confirmed, so a redeemed token
 * can never mint a link for a non-member.
 */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface HostedLinkServiceDeps {
  pool: pg.Pool;
  mailer: Mailer;
  /** Resolve the brand's loyalty API for a programme (member-number check).
   * The wallet depends on the CONTRACT interface, not a concrete core class. */
  resolveLoyalty(programme: string): LoyaltyLookup | null;
  clock: { now(): Date };
  /** Verification-token lifetime; default 15 minutes. */
  ttlS?: number;
}

export class HostedLinkService {
  private readonly ttlS: number;

  constructor(private readonly deps: HostedLinkServiceDeps) {
    this.ttlS = deps.ttlS ?? 900;
  }

  /**
   * Begin a hosted link. UNIFORM response — never an oracle for whether the
   * member number exists: an attempt row + email are created only when the
   * brand loyalty API confirms the member, but the caller always sees the
   * same `verification_sent: true`. The returned `attempt_id` is opaque.
   */
  async start(input: {
    consumerRef: string;
    merchantId: string;
    programme: string;
    memberRef: string;
    email: string;
  }): Promise<{ attempt_id: string; verification_sent: true }> {
    const attemptId = randomBytes(18).toString('base64url');
    const loyalty = this.deps.resolveLoyalty(input.programme);
    const member = loyalty ? await loyalty.memberByRef(input.memberRef).catch(() => null) : null;
    if (member) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(this.deps.clock.now().getTime() + this.ttlS * 1000);
      await this.deps.pool.query(
        `INSERT INTO wallet.hosted_link_attempts
           (attempt_id, consumer_ref, merchant_id, programme, member_ref, email, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          attemptId,
          input.consumerRef,
          input.merchantId,
          input.programme,
          input.memberRef,
          input.email,
          hashToken(token),
          expiresAt.toISOString(),
        ],
      );
      await this.deps.mailer.send({
        to: input.email,
        subject: 'Confirm your loyalty account link',
        text:
          `Confirm linking your ${input.programme} membership to your Merited wallet.\n\n` +
          `Your verification code: ${token}\n\n` +
          `This code works once and expires in ${Math.round(this.ttlS / 60)} minutes. ` +
          `If you did not request this, ignore this email — nothing is linked without it.`,
      });
    }
    return { attempt_id: attemptId, verification_sent: true };
  }

  /**
   * Complete a hosted link by redeeming the emailed token. Consumption and
   * expiry are checked in one atomic UPDATE, so a replayed token loses the
   * race. Returns null on any failure (wrong/expired/replayed token, or a
   * session mismatch) — a uniform failure, no reason oracle. On success the
   * link is byte-compatible with the OAuth flow's.
   */
  async verify(input: {
    attemptId: string;
    token: string;
    sessionConsumerRef?: string;
  }): Promise<IdentityLink | null> {
    const now = this.deps.clock.now().toISOString();
    const consumed = await this.deps.pool.query<{
      consumer_ref: string;
      merchant_id: string;
      programme: string;
      member_ref: string;
    }>(
      `UPDATE wallet.hosted_link_attempts SET consumed_at = $3
        WHERE attempt_id = $1 AND token_hash = $2 AND consumed_at IS NULL AND expires_at > $3
      RETURNING consumer_ref, merchant_id, programme, member_ref`,
      [input.attemptId, hashToken(input.token), now],
    );
    const attempt = consumed.rows[0];
    if (!attempt) return null;
    if (input.sessionConsumerRef && input.sessionConsumerRef !== attempt.consumer_ref) return null;

    const link = buildIdentityLink({
      consumerRef: attempt.consumer_ref,
      merchantId: attempt.merchant_id,
      programme: attempt.programme,
      // the member number is the "sub" for the hosted flow — for FakeAurora it
      // equals the OAuth id_token subject, so both flows yield the same sub_hash
      sub: attempt.member_ref,
      linkedAt: this.deps.clock.now().toISOString(),
    });
    await persistLink(this.deps.pool, link);
    return link;
  }
}
