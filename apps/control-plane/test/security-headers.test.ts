import { afterEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { applyHsts, hstsEnabled, HSTS_VALUE } from '../src/lib/security-headers';

/**
 * W8/#15/#19: HSTS is emitted only in production (paired with the Secure
 * cookie). A browser ignores HSTS over plain HTTP, so gating keeps it off dev
 * runs without weakening prod.
 */
describe('HSTS (W8/#15/#19)', () => {
  const { NODE_ENV } = process.env;
  const MERITED_ENV = process.env['MERITED_ENV'];
  afterEach(() => {
    if (NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = NODE_ENV;
    if (MERITED_ENV === undefined) delete process.env['MERITED_ENV'];
    else process.env['MERITED_ENV'] = MERITED_ENV;
  });

  it('does not emit HSTS outside production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env['MERITED_ENV'];
    expect(hstsEnabled()).toBe(false);
    const res = applyHsts(NextResponse.next());
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('emits HSTS in production with a one-year max-age and includeSubDomains', () => {
    process.env.NODE_ENV = 'production';
    delete process.env['MERITED_ENV'];
    expect(hstsEnabled()).toBe(true);
    const res = applyHsts(NextResponse.next());
    expect(res.headers.get('strict-transport-security')).toBe(HSTS_VALUE);
    expect(HSTS_VALUE).toContain('max-age=31536000');
    expect(HSTS_VALUE).toContain('includeSubDomains');
    expect(HSTS_VALUE).not.toContain('preload'); // deliberate — deploy decision
  });

  it('honours MERITED_ENV=dev even under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env['MERITED_ENV'] = 'dev';
    expect(hstsEnabled()).toBe(false);
  });
});
