import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import { resolve } from './resolve.js';
import { IdentityStore } from './store.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_idn_${Date.now().toString(36)}`;
const clock = { now: () => new Date() };

let admin: pg.Client;
let pool: pg.Pool;
let store: IdentityStore;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateCore(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  store = new IdentityStore(pool);

  await pool.query(
    `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status, consumer_ref) VALUES
     ('AUR-1001', 'subhash-gold', 'Gold', 'active', 'usr_gold'),
     ('AUR-1002', 'subhash-revoked', 'Member', 'revoked', NULL)`,
  );
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('identity store + resolve composition (CORE-4)', () => {
  it('an active seeded member resolves T1 through any signal', async () => {
    for (const consumer of [
      { consumer_ref: 'usr_gold' as never },
      { sub_hash: 'subhash-gold' },
      { member_ref: 'AUR-1001' },
    ]) {
      const resolved = resolve(consumer, await store.lookupsFor(consumer), clock);
      expect(resolved).toMatchObject({ tier: 'T1', identity_ref: 'AUR-1001' });
      expect(resolved.segment).toBe('t1-gold-new');
    }
  });

  it('a status=revoked row must NOT resolve T1 (B23 live-downgrade rehearsal)', async () => {
    const consumer = { sub_hash: 'subhash-revoked' };
    const resolved = resolve(consumer, await store.lookupsFor(consumer), clock);
    expect(resolved.tier).toBe('T3');

    // live revocation: flip the gold member; the very next resolution downgrades
    await pool.query(`UPDATE core.aurora_club_members SET status = 'revoked' WHERE member_ref = 'AUR-1001'`);
    const downgraded = resolve({ sub_hash: 'subhash-gold' }, await store.lookupsFor({ sub_hash: 'subhash-gold' }), clock);
    expect(downgraded.tier).toBe('T3');
    await pool.query(`UPDATE core.aurora_club_members SET status = 'active' WHERE member_ref = 'AUR-1001'`);
  });

  it('soft identities: first sighting is t2-new, repeat sightings are t2-returning', async () => {
    const hash = 'emailhash-1';
    await store.touchSoftIdentity(hash);
    const first = resolve({ hashed_email: hash }, await store.lookupsFor({ hashed_email: hash }), clock);
    expect(first).toMatchObject({ tier: 'T2', identity_ref: hash, segment: 't2-new' });

    await new Promise((r) => setTimeout(r, 20)); // distinct last_seen_at
    await store.touchSoftIdentity(hash);
    const again = resolve({ hashed_email: hash }, await store.lookupsFor({ hashed_email: hash }), clock);
    expect(again.segment).toBe('t2-returning');
  });

  it('unknown signals resolve T3 acquisition', async () => {
    const consumer = { hashed_email: 'never-seen', sub_hash: 'nobody' };
    expect(resolve(consumer, await store.lookupsFor(consumer), clock)).toEqual({
      tier: 'T3',
      identity_ref: null,
      segment: 't3-acquisition',
    });
  });
});
