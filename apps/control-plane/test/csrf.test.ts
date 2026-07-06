import { describe, expect, it } from 'vitest';
import { isCrossSite, UNSAFE_METHODS } from '../src/lib/csrf';

/** A minimal Headers-like getter (avoids the forbidden-header quirks of the
 * real Headers constructor for `host`). */
const h = (map: Record<string, string>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null });

describe('isCrossSite — CSRF Origin/Sec-Fetch-Site (W6/#16)', () => {
  it('blocks an explicit cross-site fetch (Sec-Fetch-Site)', () => {
    expect(isCrossSite(h({ 'sec-fetch-site': 'cross-site', host: 'cp.merited.test' }))).toBe(true);
  });

  it('blocks a forced-login form: Origin host differs from the target host', () => {
    expect(isCrossSite(h({ origin: 'https://evil.example', host: 'cp.merited.test' }))).toBe(true);
  });

  it('allows a same-origin request (Origin host === host)', () => {
    expect(
      isCrossSite(h({ origin: 'https://cp.merited.test', host: 'cp.merited.test', 'sec-fetch-site': 'same-origin' })),
    ).toBe(false);
  });

  it('allows a non-browser client (no Origin, no Sec-Fetch-Site) — tests / service calls', () => {
    expect(isCrossSite(h({ host: 'cp.merited.test' }))).toBe(false);
  });

  it('treats a malformed Origin as hostile', () => {
    expect(isCrossSite(h({ origin: 'not-a-url', host: 'cp.merited.test' }))).toBe(true);
  });

  it('guards the state-changing methods', () => {
    expect([...UNSAFE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
    expect(UNSAFE_METHODS.has('GET')).toBe(false);
  });
});
