import { FakeCrypter, InMemoryKms, KmsCrypter } from '@merited/signing';
import type { Crypter } from '@merited/signing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../scripts/migrate.mjs';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LinkTokenStore } from './link-token-store.js';

/**
 * PH1-8 accept: round-trip encrypt/decrypt; ciphertext at rest (a raw table
 * read shows no plaintext); tokens absent from any serialisable surface.
 * Runs the store against BOTH Crypter impls — the Phase-0 FakeCrypter and
 * the real KmsCrypter (PH1-30) — since it must be correct either side of
 * the swap.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_linktok_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;

const REFRESH = 'refresh-token-super-secret-abc123';
const ACCESS = 'access-token-also-secret-xyz789';

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrateWallet(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const crypters: Array<{ name: string; make: () => Crypter }> = [
  { name: 'FakeCrypter', make: () => new FakeCrypter('link-token-dev') },
  { name: 'KmsCrypter', make: () => new KmsCrypter(new InMemoryKms()) },
];

for (const { name, make } of crypters) {
  describe(`LinkTokenStore — ${name} (PH1-8)`, () => {
    it('round-trips a token bundle through seal → open', async () => {
      const store = new LinkTokenStore(pool, make());
      const linkId = `lnk_${name}_roundtrip`;
      await store.put(linkId, { refresh_token: REFRESH, access_token: ACCESS, expires_at: 123 });
      expect(await store.read(linkId)).toEqual({
        refresh_token: REFRESH,
        access_token: ACCESS,
        expires_at: 123,
      });
      expect(await store.read('lnk_absent')).toBeNull();
    });

    it('property: any token string round-trips unchanged', async () => {
      const store = new LinkTokenStore(pool, make());
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 200 }), fc.string(), async (rt, at) => {
          const linkId = `lnk_${name}_${Buffer.from(rt).toString('hex').slice(0, 20)}`;
          await store.put(linkId, { refresh_token: rt, access_token: at });
          expect(await store.read(linkId)).toEqual({ refresh_token: rt, access_token: at });
        }),
        { numRuns: 40 },
      );
    });

    it('CIPHERTEXT AT REST: the raw table row contains no plaintext token', async () => {
      const store = new LinkTokenStore(pool, make());
      const linkId = `lnk_${name}_atrest`;
      await store.put(linkId, { refresh_token: REFRESH, access_token: ACCESS });
      const { rows } = await pool.query<{ ciphertext: string; crypter_ref: string }>(
        `SELECT ciphertext, crypter_ref FROM wallet.link_tokens WHERE link_id = $1`,
        [linkId],
      );
      const raw = JSON.stringify(rows[0]);
      expect(raw).not.toContain(REFRESH);
      expect(raw).not.toContain(ACCESS);
      expect(raw).not.toContain('refresh_token'); // even the key name is sealed
    });

    it('revoke drops the sealed row', async () => {
      const store = new LinkTokenStore(pool, make());
      const linkId = `lnk_${name}_revoke`;
      await store.put(linkId, { refresh_token: REFRESH });
      expect(await store.remove(linkId)).toBe(true);
      expect(await store.read(linkId)).toBeNull();
      expect(await store.remove(linkId)).toBe(false);
    });

    it('put on an existing link ROTATES (one live row, new ciphertext)', async () => {
      const store = new LinkTokenStore(pool, make());
      const linkId = `lnk_${name}_rotate`;
      await store.put(linkId, { refresh_token: 'first' });
      await store.put(linkId, { refresh_token: 'second' });
      expect(await store.read(linkId)).toEqual({ refresh_token: 'second' });
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM wallet.link_tokens WHERE link_id = $1`, [linkId]);
      expect(rows[0]!.n).toBe(1);
    });
  });
}
