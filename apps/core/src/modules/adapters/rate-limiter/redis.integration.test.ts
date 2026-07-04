import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@merited/contracts';
import { RedisRateLimiter } from './redis.js';

let redis: Redis;

beforeAll(() => {
  redis = new Redis('redis://localhost:6379', { lazyConnect: false });
});

afterAll(async () => {
  await redis.quit();
});

describe('RedisRateLimiter against docker-compose Redis (§2.2)', () => {
  it('allows to the limit, denies with a live TTL, isolates keys', async () => {
    const limiter = new RedisRateLimiter(redis, { limit: 2, windowS: 30, keyPrefix: newId('agt') });
    expect((await limiter.allow('k1')).allowed).toBe(true);
    expect((await limiter.allow('k1')).allowed).toBe(true);
    const denied = await limiter.allow('k1');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBeGreaterThan(0);
    expect(denied.retryAfterS).toBeLessThanOrEqual(30);
    expect((await limiter.allow('k2')).allowed).toBe(true);
  });

  it('fails OPEN when Redis is unreachable — never a source of truth (§1)', async () => {
    const dead = new Redis('redis://localhost:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    const limiter = new RedisRateLimiter(dead, { limit: 1, windowS: 30 });
    expect(await limiter.allow('k')).toEqual({ allowed: true });
    expect(await limiter.allow('k')).toEqual({ allowed: true });
    dead.disconnect();
  });
});
