import type { RateLimiter } from '@merited/contracts';

export interface RateLimiterOptions {
  limit: number;
  windowS: number;
  /** Injected time source (SYN-30 discipline — no ambient clocks in logic). */
  now?: () => number;
  /** Hard cap on tracked keys (default 50_000). Bounds memory so a
   * key-rotation flood (e.g. a spoofed X-Forwarded-For per request) cannot
   * grow the map without limit — expired windows are swept first, then the
   * oldest windows evicted. */
  maxKeys?: number;
}

/**
 * Fixed-window in-memory rate limiter — the unit-test fake for the
 * `RateLimiter` port (§2.2) and the zero-dependency default. Per-process
 * only; the Redis adapter is the shared-state implementation. The key map is
 * bounded (`maxKeys`) so it cannot be grown into an OOM by rotating keys.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  async allow(key: string): Promise<{ allowed: boolean; retryAfterS?: number }> {
    const nowMs = (this.options.now ?? Date.now)();
    const windowMs = this.options.windowS * 1000;
    const current = this.windows.get(key);
    if (!current || nowMs - current.windowStart >= windowMs) {
      // adding a NEW key: keep the map bounded before it grows past the cap
      if (!current && this.windows.size >= this.maxKeys) this.evict(nowMs, windowMs);
      this.windows.set(key, { windowStart: nowMs, count: 1 });
      return { allowed: true };
    }
    current.count += 1;
    if (current.count <= this.options.limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterS: Math.max(1, Math.ceil((current.windowStart + windowMs - nowMs) / 1000)),
    };
  }

  /** Drop expired windows first (a rotating-key flood leaves a trail of them);
   * if the map is still at the cap, evict the oldest windows. Runs only when a
   * new key would exceed `maxKeys`, so the O(n) cost is amortised. */
  private evict(nowMs: number, windowMs: number): void {
    for (const [k, w] of this.windows) {
      if (nowMs - w.windowStart >= windowMs) this.windows.delete(k);
    }
    if (this.windows.size < this.maxKeys) return;
    const byAge = [...this.windows.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    const drop = this.windows.size - this.maxKeys + 1;
    for (let i = 0; i < drop; i += 1) this.windows.delete(byAge[i]![0]);
  }
}
