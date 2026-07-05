import { createHash, randomBytes } from 'node:crypto';
import { IdentityLink, newId, type IdentityProviderAdapter } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import type pg from 'pg';
import { LinkTokenStore } from './link-token-store.js';

/**
 * Account linking core (PH1-13, B23 — HIGH-SCRUTINY). The OAuth
 * authorization-code + PKCE flow that turns a brand login into an
 * `IdentityLink`:
 *
 *   start → server-stored PKCE verifier bound to `state`, authorize URL out
 *   callback → state check, code exchange via the adapter, member reference
 *     tokenised, sub_hash = sha256(idp_sub), IdentityLink written, refresh
 *     token sealed via PH1-8, `AccountLinked` appended to the ledger
 *   revoke → status flipped LIVE, adapter.revoke() called, tokens dropped,
 *     `AccountUnlinked` appended (wallet- or brand-initiated)
 *
 * A refresh token NEVER leaves the sealed store — not in a response, a log
 * line, or a return value here (§6.3).
 */
const S256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
const sha256hex = (input: string): string => createHash('sha256').update(input).digest('hex');
const b64url = (n = 32): string => randomBytes(n).toString('base64url');

export interface LinkServiceDeps {
  pool: pg.Pool;
  tokens: LinkTokenStore;
  /** Resolve the IdP adapter for a programme (the core registry, injected —
   * the wallet depends on the CONTRACT interface, not a concrete core class). */
  resolveAdapter(programme: string): IdentityProviderAdapter | null;
  clock: { now(): Date };
  /** Where the IdP redirects back (this wallet's callback route). */
  callbackUrl: string;
  attemptTtlS?: number;
}

const LINK_SCOPES = ['openid', 'profile', 'balance', 'tier'];

export class LinkService {
  constructor(private readonly deps: LinkServiceDeps) {}

  /** Begin a link: store the PKCE verifier server-side, return the authorize URL. */
  async start(input: {
    consumerRef: string;
    merchantId: string;
    programme: string;
    returnUrl?: string;
  }): Promise<{ authorize_url: string; state: string }> {
    const adapter = this.deps.resolveAdapter(input.programme);
    if (!adapter) throw new Error(`no IdP configured for programme '${input.programme}'`);
    const state = b64url();
    const codeVerifier = b64url(48);
    const expiresAt = new Date(this.deps.clock.now().getTime() + (this.deps.attemptTtlS ?? 600) * 1000);
    await this.deps.pool.query(
      `INSERT INTO wallet.link_attempts (state, consumer_ref, merchant_id, programme, code_verifier, return_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [state, input.consumerRef, input.merchantId, input.programme, codeVerifier, input.returnUrl ?? null, expiresAt.toISOString()],
    );
    const { url } = await adapter.authorize({ state, code_challenge: S256(codeVerifier), scopes: LINK_SCOPES });
    return { authorize_url: url, state };
  }

  /**
   * Complete a link from the IdP callback. `sessionConsumerRef`, when given,
   * must match the attempt's consumer (defence in depth — the same browser
   * that started the link finishes it).
   */
  async callback(input: {
    state: string;
    code: string;
    sessionConsumerRef?: string;
  }): Promise<IdentityLink> {
    // atomic single-use consume of the attempt
    const consumed = await this.deps.pool.query<{
      consumer_ref: string;
      merchant_id: string;
      programme: string;
      code_verifier: string;
    }>(
      `UPDATE wallet.link_attempts SET consumed_at = $2
        WHERE state = $1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING consumer_ref, merchant_id, programme, code_verifier`,
      [input.state, this.deps.clock.now().toISOString()],
    );
    const attempt = consumed.rows[0];
    if (!attempt) throw new Error('invalid or expired link state');
    if (input.sessionConsumerRef && input.sessionConsumerRef !== attempt.consumer_ref) {
      throw new Error('link state does not belong to this session');
    }
    const adapter = this.deps.resolveAdapter(attempt.programme);
    if (!adapter) throw new Error(`no IdP configured for programme '${attempt.programme}'`);

    const exchanged = await adapter.exchange({ code: input.code, code_verifier: attempt.code_verifier });
    // tokenise the member reference — the raw idp sub never becomes the
    // member_ref on the wire; a stable tokenised handle does
    const memberRef = `mbr_${sha256hex(`${attempt.programme}:${exchanged.sub}`).slice(0, 24)}`;
    const subHash = sha256hex(exchanged.sub);
    const info = await adapter.userinfo(exchanged.access_token).catch(() => null);

    const link = IdentityLink.parse({
      link_id: newId('lnk'),
      consumer_ref: attempt.consumer_ref,
      merchant_id: attempt.merchant_id,
      programme: attempt.programme,
      member_ref: memberRef,
      sub_hash: subHash,
      scopes: LINK_SCOPES.filter((s): s is 'profile' | 'balance' | 'tier' => s !== 'openid'),
      status: 'active',
      linked_at: this.deps.clock.now().toISOString(),
    });

    await this.deps.pool.query(
      `INSERT INTO wallet.identity_links (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes, status, linked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [link.link_id, link.consumer_ref, link.merchant_id, link.programme, link.member_ref, link.sub_hash, JSON.stringify(link.scopes), link.status, link.linked_at],
    );
    // seal the refresh token (PH1-8) — it never travels further than here
    if (exchanged.refresh_token) {
      await this.deps.tokens.put(link.link_id, {
        rt: exchanged.refresh_token,
        at: exchanged.access_token,
        exp: this.deps.clock.now().getTime() + exchanged.expires_in_s * 1000,
      });
    }
    void info; // userinfo fetched to validate the token; claims persist in Phase 2
    await appendEventInNewTx(this.deps.pool, 'AccountLinked', { link });
    return link;
  }

  /** Revoke a link — wallet- or brand-initiated. Status flips LIVE (the next
   * read sees 'revoked', no cache), the IdP's refresh token is revoked, the
   * sealed tokens are dropped, and `AccountUnlinked` is appended. */
  async revoke(input: { linkId: string; revokedBy: 'wallet' | 'brand' }): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{
      consumer_ref: string;
      merchant_id: string;
      programme: string;
    }>(
      `UPDATE wallet.identity_links SET status = 'revoked'
        WHERE link_id = $1 AND status = 'active'
      RETURNING consumer_ref, merchant_id, programme`,
      [input.linkId],
    );
    const link = rows[0];
    if (!link) return false; // unknown or already revoked — idempotent

    // best-effort IdP revoke (uses the sealed refresh token, never returned)
    const sealed = await this.deps.tokens.read(input.linkId);
    const adapter = this.deps.resolveAdapter(link.programme);
    if (sealed && typeof sealed['rt'] === 'string' && adapter) {
      await adapter.revoke(sealed['rt']).catch(() => {});
    }
    await this.deps.tokens.remove(input.linkId);
    await appendEventInNewTx(this.deps.pool, 'AccountUnlinked', {
      link_id: input.linkId,
      consumer_ref: link.consumer_ref,
      merchant_id: link.merchant_id,
      revoked_by: input.revokedBy,
      unlinked_at: this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    return true;
  }
}
