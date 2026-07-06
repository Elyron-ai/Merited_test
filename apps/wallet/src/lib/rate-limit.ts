/**
 * Bounded fixed-window rate limiting for the wallet's public surfaces
 * (audit W4/#23). Per-process and self-bounding — a rotating-key flood can
 * never grow the map past `maxKeys` (expired windows swept, then oldest
 * evicted). Kept local to the wallet (its own service boundary — no runtime
 * dependency on @merited/core); a Redis-backed cross-instance limiter is the
 * production upgrade (launch-readiness A9).
 */
export class BoundedRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const nowMs = this.now();
    const current = this.windows.get(key);
    if (!current || nowMs - current.windowStart >= this.windowMs) {
      if (!current && this.windows.size >= this.maxKeys) this.evict(nowMs);
      this.windows.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private evict(nowMs: number): void {
    for (const [k, w] of this.windows) {
      if (nowMs - w.windowStart >= this.windowMs) this.windows.delete(k);
    }
    if (this.windows.size < this.maxKeys) return;
    const byAge = [...this.windows.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    const drop = this.windows.size - this.maxKeys + 1;
    for (let i = 0; i < drop; i += 1) this.windows.delete(byAge[i]![0]);
  }
}

// Magic-link request throttle: per source IP (Fastify `req.ip` — the socket
// peer, not a spoofable header) AND per target email. Generous enough for
// legitimate re-requests; tight enough to stop email bombing of an arbitrary
// address once a real mail provider (Resend, launch-readiness B2) is wired.
const perIp = new BoundedRateLimiter(20, 15 * 60_000);
const perEmail = new BoundedRateLimiter(5, 15 * 60_000);

export const allowMagicLink = (ip: string, email: string): boolean =>
  // both must pass; evaluated eagerly so each attempt counts toward both
  [perIp.allow(`ip:${ip}`), perEmail.allow(`email:${email.toLowerCase()}`)].every(Boolean);
