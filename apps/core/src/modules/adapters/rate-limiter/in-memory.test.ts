import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './in-memory.js';

describe('InMemoryRateLimiter (RateLimiter port fake)', () => {
  it('allows up to the limit, then denies with retryAfterS, then resets on window roll', async () => {
    let nowMs = 1_000_000;
    const limiter = new InMemoryRateLimiter({ limit: 3, windowS: 60, now: () => nowMs });

    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.allow('agt_1')).toEqual({ allowed: true });
    }
    const denied = await limiter.allow('agt_1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBeGreaterThan(0);
    expect(denied.retryAfterS).toBeLessThanOrEqual(60);

    nowMs += 61_000; // window rolls
    expect(await limiter.allow('agt_1')).toEqual({ allowed: true });
  });

  it('keys are independent', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, windowS: 60, now: () => 5_000 });
    expect((await limiter.allow('a')).allowed).toBe(true);
    expect((await limiter.allow('a')).allowed).toBe(false);
    expect((await limiter.allow('b')).allowed).toBe(true);
  });
});
