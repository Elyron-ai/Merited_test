import type { ReplayCache } from '@merited/contracts';
import type { Redis } from 'ioredis';

/**
 * Redis fast-path replay cache (PH1-25) over FND-6's port. NEVER a source
 * of truth (§1): the Postgres consumption transaction is authoritative for
 * every verified verdict; this cache only lets an obvious replay reject
 * before a database round-trip. Every operation fails OPEN (false) — a
 * dead Redis degrades to the Postgres path, never to a wrong verdict.
 */
export class RedisReplayCache implements ReplayCache {
  constructor(private readonly redis: Redis) {}

  async seenBefore(key: string, ttlS: number): Promise<boolean> {
    try {
      const set = await this.redis.set(`replay:${key}`, '1', 'EX', ttlS, 'NX');
      return set === null; // null = key existed
    } catch {
      return false;
    }
  }

  async peek(key: string): Promise<boolean> {
    try {
      return (await this.redis.exists(`replay:${key}`)) === 1;
    } catch {
      return false;
    }
  }
}

/** Unit fake with the same semantics (no TTL expiry — tests are short). */
export class InMemoryReplayCache implements ReplayCache {
  private readonly keys = new Set<string>();

  async seenBefore(key: string): Promise<boolean> {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    return false;
  }

  async peek(key: string): Promise<boolean> {
    return this.keys.has(key);
  }
}
