import { EnvValidationError } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { loadCoreEnv } from './env.js';

describe('core env loader (§8 fail-fast)', () => {
  it('missing vars fail boot with every var named', () => {
    try {
      loadCoreEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { message } = error as EnvValidationError;
      expect(message).toContain('MERITED_DATABASE_URL: missing');
      expect(message).toContain('MERITED_REDIS_URL: missing');
    }
  });

  it('valid source parses, port defaults and coerces', () => {
    const env = loadCoreEnv({
      MERITED_DATABASE_URL: 'postgres://merited_app:x@localhost:5432/merited',
      MERITED_REDIS_URL: 'redis://localhost:6379',
    });
    expect(env.MERITED_CORE_PORT).toBe(3100);
    expect(
      loadCoreEnv({
        MERITED_DATABASE_URL: 'postgres://merited_app:x@localhost:5432/merited',
        MERITED_REDIS_URL: 'redis://localhost:6379',
        MERITED_CORE_PORT: '4001',
      }).MERITED_CORE_PORT,
    ).toBe(4001);
  });
});
