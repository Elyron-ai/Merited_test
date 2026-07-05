import type { Money } from '../money.js';
import type { OrderConfirmed } from '../order.js';

/**
 * Vendor port interfaces (BUILD-SPEC §0.2/§2.2): every third-party dependency
 * sits behind an adapter interface with a fake. These are the single-source
 * homes (§1) — implementations and fakes live with their consuming
 * workstreams; semantics are refined via contracts-first PRs.
 */

/**
 * Redis-backed replay fast-path (§2.2 Upstash Redis row; fake: in-memory /
 * docker-compose Redis; wire-up phase 0). NEVER a source of truth — the
 * Postgres unique-jti store is authoritative (TRIO-6, spec §7.2).
 */
export interface ReplayCache {
  /** true if the key was already present; records it with the given TTL otherwise. */
  seenBefore(key: string, ttlS: number): Promise<boolean>;
  /** Read-only check — never records (PH1-25: the verify pipeline's stage-2
   * fast path peeks; only CONSUMPTION records via seenBefore). */
  peek(key: string): Promise<boolean>;
}

/**
 * Per-agent / per-merchant rate limiting (§2.2; fake: in-memory; compose
 * Redis locally; wire-up phase 0). §8: limits on every public surface.
 */
export interface RateLimiter {
  allow(key: string): Promise<{ allowed: boolean; retryAfterS?: number }>;
}

/**
 * Outbound email (§2.2 Resend row; fake: mailpit container; wire-up phase 1
 * with PH1-7). Used by magic-link auth (PH1-9) and hosted linking (PH1-14).
 */
export interface Mailer {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

/**
 * Commerce integration (§2.2 Shopify row, §5.8; fake: FakeShop inside
 * apps/fake-aurora — MER-11; real wire-up phase 3 with PH3-5). Normalises a
 * platform-native order event into OrderConfirmed; claim building/signing is
 * the adapter pipeline's job (MER-4), not the port's.
 */
export interface CommerceAdapter {
  normaliseOrderEvent(raw: unknown): OrderConfirmed;
}

/**
 * Brand identity providers (§2.2 OAuth2/OIDC row; fake: FakeAurora IdP —
 * PH1-10; wire-up phase 1 via the per-programme registry, PH1-12).
 */
export interface IdentityProviderAdapter {
  authorize(input: { state: string; code_challenge: string; scopes: string[] }): Promise<{ url: string }>;
  exchange(input: { code: string; code_verifier: string }): Promise<{
    sub: string;
    access_token: string;
    refresh_token?: string;
    expires_in_s: number;
  }>;
  refresh(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in_s: number }>;
  userinfo(accessToken: string): Promise<{ sub: string; claims: Record<string, unknown> }>;
  revoke(token: string): Promise<void>;
}

/**
 * Loyalty programme lookup (§2.2 Eagle Eye AIR row; fakes: seeded static
 * membership table — CORE-4 — and the FakeAurora loyalty API — PH1-11; real
 * vendor wiring is partner-conditional, PH2-10/SYN-31).
 */
export interface LoyaltyLookup {
  memberByRef(memberRef: string): Promise<{ tier: string; balance: number } | null>;
  creditPoints(input: { member_ref: string; points: number; order_ref_hash: string }): Promise<void>;
}

/**
 * Payout rail (§2.2 Stripe Connect row; Phase-1 BEHAVIOUR is SimulatedPayouts
 * — statements only, PH1-29; Stripe Connect test-mode wire-up is PH2-6 behind
 * this same interface). Amounts integer pence, always.
 */
export interface PayoutRail {
  createAccount(party: string): Promise<{ account_ref: string }>;
  transfer(input: { account_ref: string; amount: Money; idempotency_key: string }): Promise<{ transfer_ref: string }>;
  reverse(transferRef: string): Promise<void>;
}
