import { describe, expect, it } from 'vitest';
import { createCoreDb } from './db.js';

describe('core db (CORE-1) — role-asserted runtime pool', () => {
  it('connects to docker-compose as merited_app and queries', async () => {
    const core = createCoreDb('postgres://merited_app:merited_app_dev@localhost:5432/merited');
    try {
      const { rows } = await core.pool.query('SELECT 1 AS one');
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await core.close();
    }
  });

  it('rejects a non-app URL at construction (D8)', () => {
    expect(() =>
      createCoreDb('postgres://merited_migrate:merited_migrate_dev@localhost:5432/merited'),
    ).toThrow(/merited_app/);
  });
});
