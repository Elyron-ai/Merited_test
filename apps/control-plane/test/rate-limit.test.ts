import { describe, expect, it } from 'vitest';
import { allowLogin, allowSignup, clientIp } from '../src/lib/rate-limit';

/**
 * Audit W4 (#2/#4/#11/#12/#22): the control-plane public-surface abuse
 * controls. `clientIp` derives a non-left-spoofable IP; the limiters bound
 * the expensive signup/login paths, with a global backstop that header
 * rotation cannot bypass.
 */

const h = (xff?: string): Headers => {
  const headers = new Headers();
  if (xff !== undefined) headers.set('x-forwarded-for', xff);
  return headers;
};

describe('clientIp (trusted-proxy derivation)', () => {
  it('hops=0 takes the RIGHTMOST entry (what the nearest trusted proxy appended)', () => {
    // an attacker prepends spoofed values on the left; only the right entry is trustworthy
    expect(clientIp(h('9.9.9.9, 8.8.8.8, 203.0.113.7'), 0)).toBe('203.0.113.7');
  });

  it('hops=1 skips one appended proxy hop', () => {
    expect(clientIp(h('9.9.9.9, 203.0.113.7, 10.0.0.1'), 1)).toBe('203.0.113.7');
  });

  it('a purely attacker-supplied XFF cannot forge a distinct real IP (leftmost is ignored)', () => {
    // the spoofed leftmost value never becomes the key at hops>=0
    expect(clientIp(h('1.2.3.4'), 1)).toBe('unknown'); // fewer entries than hops
    expect(clientIp(h(''), 0)).toBe('unknown');
    expect(clientIp(h(undefined), 0)).toBe('unknown');
  });
});

describe('allowLogin (per-email brute-force cap, argon2-DoS throttle)', () => {
  it('caps repeated attempts on ONE email even from varying IPs', async () => {
    const email = `victim-${Math.random().toString(36).slice(2)}@ops.test`;
    let denied = false;
    for (let i = 0; i < 15 && !denied; i += 1) {
      const v = await allowLogin(`ip-${i}`, email); // distinct IPs → per-IP cap never trips
      denied = !v.allowed;
    }
    expect(denied).toBe(true); // per-email cap (10/15min) throttles the brute force
  });

  it('a different email is unaffected (per-email isolation)', async () => {
    const fresh = `fresh-${Math.random().toString(36).slice(2)}@ops.test`;
    expect((await allowLogin('some-ip', fresh)).allowed).toBe(true);
  });
});

describe('allowSignup (global backstop is spoof-proof)', () => {
  it('a global ceiling denies even when every request uses a DISTINCT (spoofed) IP', async () => {
    let denied = false;
    // distinct IP each call → the per-IP cap can never trip; only the global
    // ceiling can — proving X-Forwarded-For rotation does not bypass the limit
    for (let i = 0; i < 250 && !denied; i += 1) {
      const v = await allowSignup(`spoofed-${i}`);
      denied = !v.allowed;
    }
    expect(denied).toBe(true);
  });
});
