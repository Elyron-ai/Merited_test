import { InMemoryRateLimiter } from '@merited/core';

/**
 * Abuse controls for the control plane's public POST surfaces (§8: limits on
 * every public surface). Per-process, bounded (the core limiter caps its key
 * map so a spoofed-header flood can't OOM it — audit W4/#11). Redis-backed
 * cross-instance limiting is the production upgrade (launch-readiness A9).
 *
 * Client IP: X-Forwarded-For is attacker-controlled on the LEFT — a caller
 * prepends whatever it likes. Only the entry the *outermost trusted proxy*
 * appends (on the right) is reliable, so we take the entry
 * `CONTROL_PLANE_TRUSTED_PROXY_HOPS`-from-the-right. A deploy with no proxy in
 * front cannot derive a trustworthy per-IP key at all — the global caps below
 * are the header-spoof-proof backstop for the expensive paths.
 */
const trustedHops = (): number => {
  const raw = Number.parseInt(process.env['CONTROL_PLANE_TRUSTED_PROXY_HOPS'] ?? '0', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
};

export const clientIp = (headers: Headers, hops: number = trustedHops()): string => {
  const xff = headers.get('x-forwarded-for');
  if (!xff) return 'unknown';
  const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
  const idx = parts.length - 1 - hops;
  return idx >= 0 ? parts[idx]! : 'unknown';
};

export interface LimitVerdict {
  allowed: boolean;
  retryAfterS: number;
}

const worst = (...verdicts: Array<{ allowed: boolean; retryAfterS?: number }>): LimitVerdict => {
  const denied = verdicts.find((v) => !v.allowed);
  return denied
    ? { allowed: false, retryAfterS: denied.retryAfterS ?? 60 }
    : { allowed: true, retryAfterS: 0 };
};

// Signup: per-IP AND a global ceiling that header spoofing cannot bypass — an
// attacker rotating X-Forwarded-For still hits the global cap on the expensive
// onboarding path (merchant record + trio keypair + published offer).
const perIpSignup = new InMemoryRateLimiter({ limit: 20, windowS: 3600 });
const globalSignup = new InMemoryRateLimiter({ limit: 200, windowS: 3600 });

// Login: per-IP (argon2id flood) AND per-email (credential / TOTP brute force),
// checked BEFORE the expensive argon2 verify. No global cap — that would let
// one attacker lock every operator out.
const perIpLogin = new InMemoryRateLimiter({ limit: 30, windowS: 300 });
const perEmailLogin = new InMemoryRateLimiter({ limit: 10, windowS: 900 });

export const allowSignup = async (ip: string): Promise<LimitVerdict> =>
  worst(await perIpSignup.allow(`ip:${ip}`), await globalSignup.allow('global'));

export const allowLogin = async (ip: string, email: string): Promise<LimitVerdict> =>
  worst(
    await perIpLogin.allow(`ip:${ip}`),
    await perEmailLogin.allow(`email:${email.toLowerCase()}`),
  );
