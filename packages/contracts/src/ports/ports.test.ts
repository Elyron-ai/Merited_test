import { describe, expect, it } from 'vitest';
import type { Mailer, RateLimiter, ReplayCache } from './index.js';

describe('vendor ports (FND-6 accept — types compile, importable downstream)', () => {
  it('interfaces are implementable (compile-time proof exercised at runtime)', async () => {
    const seen = new Set<string>();
    const replay: ReplayCache = {
      seenBefore: (key) => {
        const before = seen.has(key);
        seen.add(key);
        return Promise.resolve(before);
      },
      peek: (key) => Promise.resolve(seen.has(key)),
    };
    const limiter: RateLimiter = { allow: () => Promise.resolve({ allowed: true }) };
    const sent: string[] = [];
    const mailer: Mailer = {
      send: (m) => {
        sent.push(m.to);
        return Promise.resolve();
      },
    };

    expect(await replay.peek('atk_x')).toBe(false); // peek never records
    expect(await replay.seenBefore('atk_x', 600)).toBe(false);
    expect(await replay.seenBefore('atk_x', 600)).toBe(true);
    expect(await replay.peek('atk_x')).toBe(true);
    expect((await limiter.allow('agt_y')).allowed).toBe(true);
    await mailer.send({ to: 'consumer@example.co.uk', subject: 'Link', text: 'Your link' });
    expect(sent).toEqual(['consumer@example.co.uk']);
  });
});
