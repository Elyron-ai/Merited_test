import { describe, expect, it } from 'vitest';
import { assertUrlRole } from './db.js';

describe('connection role assertions (FND-9 accept, D8)', () => {
  it('accepts the matching role', () => {
    expect(assertUrlRole('postgres://merited_app:x@localhost:5432/merited', 'merited_app')).toBe(
      'postgres://merited_app:x@localhost:5432/merited',
    );
  });

  it('rejects runtime connections as any role other than merited_app', () => {
    expect(() =>
      assertUrlRole('postgres://merited_migrate:x@localhost:5432/merited', 'merited_app'),
    ).toThrow(/merited_app/);
    expect(() =>
      assertUrlRole('postgres://merited_admin:x@localhost:5432/merited', 'merited_app'),
    ).toThrow(/merited_app/);
  });
});
