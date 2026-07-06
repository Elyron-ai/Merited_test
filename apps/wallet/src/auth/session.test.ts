import { afterEach, describe, expect, it } from 'vitest';
import {
  serializeSessionCookie,
  walletCookieIsSecure,
  WALLET_SESSION_COOKIE,
} from './session.js';

/**
 * W8/#15/#19: the session cookie must gain the `Secure` flag in production so
 * the 30-day session cookie cannot leak over an induced plain-HTTP request,
 * while dev/test (plain HTTP) still works. Same env gate as the control-plane.
 */
describe('serializeSessionCookie hardening (W8/#15/#19 — Secure flag)', () => {
  const { NODE_ENV } = process.env;
  const MERITED_ENV = process.env['MERITED_ENV'];
  afterEach(() => {
    // vitest sets NODE_ENV=test; restore the exact prior values
    if (NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = NODE_ENV;
    if (MERITED_ENV === undefined) delete process.env['MERITED_ENV'];
    else process.env['MERITED_ENV'] = MERITED_ENV;
  });

  it('omits Secure outside production (dev/test over plain HTTP still works)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env['MERITED_ENV'];
    expect(walletCookieIsSecure()).toBe(false);
    const cookie = serializeSessionCookie('sess_abc.mac');
    expect(cookie).toContain(`${WALLET_SESSION_COOKIE}=sess_abc.mac`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env['MERITED_ENV'];
    expect(walletCookieIsSecure()).toBe(true);
    expect(serializeSessionCookie('sess_abc.mac')).toContain('Secure');
  });

  it('honours MERITED_ENV=dev as a non-secure escape hatch even in production', () => {
    process.env.NODE_ENV = 'production';
    process.env['MERITED_ENV'] = 'dev';
    expect(walletCookieIsSecure()).toBe(false);
    expect(serializeSessionCookie('sess_abc.mac')).not.toContain('Secure');
  });

  it('serialises the clear cookie with Max-Age=0 and matching attributes', () => {
    process.env.NODE_ENV = 'production';
    delete process.env['MERITED_ENV'];
    const cleared = serializeSessionCookie('', { maxAge: 0 });
    expect(cleared).toContain(`${WALLET_SESSION_COOKIE}=;`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Secure'); // must match the set cookie to delete it
  });
});
