import { afterEach, describe, expect, it } from 'vitest';
import { secretFromEnv } from '../src/lib/require-secret';

/**
 * W11 (dev-secret fail-open): in production an unset secret must be fatal, never
 * silently the public dev default (which would mint forgeable operator cookies /
 * a known inter-service token). Dev/test keep the convenient fallback.
 */
describe('secretFromEnv fail-fast (W11)', () => {
  const KEY = 'W11_TEST_SECRET';
  const { NODE_ENV } = process.env;
  const MERITED_ENV = process.env['MERITED_ENV'];
  afterEach(() => {
    delete process.env[KEY];
    if (NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = NODE_ENV;
    if (MERITED_ENV === undefined) delete process.env['MERITED_ENV'];
    else process.env['MERITED_ENV'] = MERITED_ENV;
  });

  it('returns the env value when set (any environment)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env['MERITED_ENV'];
    process.env[KEY] = 'real-secret';
    expect(secretFromEnv(KEY, 'dev-fallback')).toBe('real-secret');
  });

  it('falls back to the dev default outside production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env['MERITED_ENV'];
    delete process.env[KEY];
    expect(secretFromEnv(KEY, 'dev-fallback')).toBe('dev-fallback');
  });

  it('THROWS in production when unset — never adopts the public dev default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env['MERITED_ENV'];
    delete process.env[KEY];
    expect(() => secretFromEnv(KEY, 'dev-fallback')).toThrow(/must be set in production/);
  });

  it('honours MERITED_ENV=dev as an escape hatch under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env['MERITED_ENV'] = 'dev';
    delete process.env[KEY];
    expect(secretFromEnv(KEY, 'dev-fallback')).toBe('dev-fallback');
  });
});
