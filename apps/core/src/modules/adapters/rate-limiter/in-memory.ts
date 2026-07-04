import type { RateLimiter } from '@merited/contracts';

export interface RateLimiterOptions {
  limit: number;
  windowS: number;
  /** Injected time source (SYN-30 discipline — no ambient clocks in logic). */
  now?: () => number;
}

/**
 * Fixed-window in-memory rate limiter — the unit-test fake for the
 * `RateLimiter` port (§2.2) and the zero-dependency default. Per-process
 * only; the Redis adapter is the shared-state implementation.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly options: RateLimiterOptions) {}

  async allow(key: string): Promise<{ allowed: boolean; retryAfterS?: number }> {
    const nowMs = (this.options.now ?? Date.now)();
    const windowMs = this.options.windowS * 1000;
    const current = this.windows.get(key);
    if (!current || nowMs - current.windowStart >= windowMs) {
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
}
