import type { RateLimiter } from '@merited/contracts';
import type { Redis } from 'ioredis';

export interface RedisRateLimiterOptions {
  limit: number;
  windowS: number;
  keyPrefix?: string;
}

/**
 * Redis fixed-window rate limiter over the `RateLimiter` port (§2.2, CORE-1):
 * INCR + first-hit EXPIRE per (prefix, key, window). Redis is NEVER a source
 * of truth (§1) — on any Redis failure this limiter FAILS OPEN: rate limits
 * are protective throttles, not authorisation, so availability wins and the
 * authoritative checks (auth, verification) still stand.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly options: RedisRateLimiterOptions,
  ) {}

  async allow(key: string): Promise<{ allowed: boolean; retryAfterS?: number }> {
    const bucket = `${this.options.keyPrefix ?? 'ratelimit'}:${key}`;
    try {
      const count = await this.redis.incr(bucket);
      if (count === 1) await this.redis.expire(bucket, this.options.windowS);
      if (count <= this.options.limit) return { allowed: true };
      const ttl = await this.redis.ttl(bucket);
      return { allowed: false, retryAfterS: ttl > 0 ? ttl : this.options.windowS };
    } catch {
      return { allowed: true }; // fail open — Redis is never a source of truth
    }
  }
}
