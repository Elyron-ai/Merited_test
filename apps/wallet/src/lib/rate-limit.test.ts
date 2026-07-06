import { describe, expect, it } from 'vitest';
import { BoundedRateLimiter, allowMagicLink } from './rate-limit.js';

/**
 * W4/#23: the wallet's public magic-link endpoint throttle — per-IP and
 * per-email, on a bounded limiter that a rotating-key flood cannot OOM.
 */
describe('BoundedRateLimiter', () => {
  it('allows up to the limit within a window, then denies', () => {
    let now = 1_000_000;
    const rl = new BoundedRateLimiter(3, 60_000, 50_000, () => now);
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a')]).toEqual([true, true, true]);
    expect(rl.allow('a')).toBe(false);
    now += 61_000; // window rolls
    expect(rl.allow('a')).toBe(true);
  });

  it('bounds the key map under a rotating-key flood', () => {
    const rl = new BoundedRateLimiter(5, 60_000, 10, () => 1_000_000);
    for (let i = 0; i < 5_000; i += 1) expect(rl.allow(`k${i}`)).toBe(true);
    // @ts-expect-error — reach into the private map to assert the memory bound
    expect((rl as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(10);
  });
});

describe('allowMagicLink (per-IP + per-email)', () => {
  it('caps repeated requests for ONE email across varying IPs (email bombing)', () => {
    const email = `bomb-${Math.random().toString(36).slice(2)}@test.co.uk`;
    let denied = false;
    for (let i = 0; i < 10 && !denied; i += 1) denied = !allowMagicLink(`ip-${i}`, email);
    expect(denied).toBe(true); // per-email cap (5/15m) trips despite distinct IPs
  });

  it('a different email is unaffected', () => {
    expect(allowMagicLink('some-ip', `fresh-${Math.random().toString(36).slice(2)}@test.co.uk`)).toBe(true);
  });
});
