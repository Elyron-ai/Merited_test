import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEnv, EnvValidationError } from './env.js';

describe('defineEnv (FND-3 accept — §8 fail fast with the complete list)', () => {
  const shape = {
    MERITED_ENV: z.enum(['dev', 'test', 'demo', 'prod']),
    MERITED_DATABASE_URL: z.string().url(),
    MERITED_QUOTE_TTL_S: z.coerce.number().int().positive().default(900),
  };

  it('returns typed, coerced values on success', () => {
    const env = defineEnv(shape, {
      MERITED_ENV: 'dev',
      MERITED_DATABASE_URL: 'postgres://localhost:5432/merited',
      MERITED_QUOTE_TTL_S: '30',
    });
    expect(env.MERITED_ENV).toBe('dev');
    expect(env.MERITED_QUOTE_TTL_S).toBe(30);
  });

  it('applies defaults for optional vars', () => {
    const env = defineEnv(shape, {
      MERITED_ENV: 'test',
      MERITED_DATABASE_URL: 'postgres://localhost:5432/merited',
    });
    expect(env.MERITED_QUOTE_TTL_S).toBe(900);
  });

  it('aggregates ALL missing and invalid vars into one thrown report', () => {
    let caught: unknown;
    try {
      defineEnv(shape, { MERITED_QUOTE_TTL_S: 'not-a-number' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.problems).toHaveLength(3);
    expect(err.message).toContain('MERITED_ENV: missing');
    expect(err.message).toContain('MERITED_DATABASE_URL: missing');
    expect(err.message).toContain('MERITED_QUOTE_TTL_S');
  });

  it('does not read vars outside the declared shape', () => {
    const env = defineEnv(
      { MERITED_ENV: z.enum(['dev']) },
      { MERITED_ENV: 'dev', UNRELATED_SECRET: 'x' },
    );
    expect(Object.keys(env)).toEqual(['MERITED_ENV']);
  });
});
