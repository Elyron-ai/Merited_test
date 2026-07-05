import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../../wallet/scripts/migrate.mjs';
import { resolve } from './resolve.js';
import { IdentityStore } from './store.js';
import { PgIdentityLinkReader } from './link-reader.js';

/**
 * PH1-15: identity resolution consumes the REAL B23 IdentityLink (PH1-13/14).
 * An active link resolves T1 through any signal; the link's status is
 * authoritative and read LIVE (a revocation downgrades the next resolution,
 * ≤5s, no cache — §6.3); an unlinked seeded member still resolves T1 via the
 * demoted Phase-0 fallback; the member tier bridges from that fallback.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_linkres_${Date.now().toString(36)}`;
const clock = { now: () => new Date() };
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

// a real seeded Aurora member (Member tier) — the link and the seeded fallback
// derive from the same subject, so the tokenised member_ref bridges to the tier
const PROGRAMME = 'aurora-club';
const ADA = 'am_seed_ada';
const ADA_LINK_SUBHASH = sha256hex(ADA); // the link's sub_hash (PH1-13/14 derivation)
const ADA_MEMBER_REF = `mbr_${sha256hex(`${PROGRAMME}:${ADA}`).slice(0, 24)}`;
const ADA_SEED_SUBHASH = sha256hex(`${PROGRAMME}:${ADA}`); // VAL-9 seeded derivation

// a Gold member, linked, to prove the tier bridge carries Gold through
const CYN = 'am_seed_cyn';
const CYN_LINK_SUBHASH = sha256hex(CYN);
const CYN_MEMBER_REF = `mbr_${sha256hex(`${PROGRAMME}:${CYN}`).slice(0, 24)}`;
const CYN_SEED_SUBHASH = sha256hex(`${PROGRAMME}:${CYN}`);

let admin: pg.Client;
let pool: pg.Pool;
let store: IdentityStore;

const insertLink = async (
  linkId: string,
  consumerRef: string,
  memberRef: string,
  subHash: string,
): Promise<void> => {
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, $2)`, [
    consumerRef,
    `${consumerRef}@link.test`,
  ]);
  await pool.query(
    `INSERT INTO wallet.identity_links
       (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes, status, linked_at)
     VALUES ($1, $2, 'mer_00SEEDAVR0RA00000000000000', $3, $4, $5, '["profile","balance","tier"]'::jsonb, 'active', now())`,
    [linkId, consumerRef, PROGRAMME, memberRef, subHash],
  );
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const migrateUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(migrateUrl);
  await migrateCore(migrateUrl);
  await migrateWallet(migrateUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  store = new IdentityStore(pool, new PgIdentityLinkReader(pool));

  // the seeded fallback (tier source), plus one UNLINKED seeded member
  await pool.query(
    `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status) VALUES
       ($1, $2, 'Member', 'active'),
       ($3, $4, 'Gold', 'active'),
       ('am_seed_unlinked', $5, 'Gold', 'active')`,
    [ADA, ADA_SEED_SUBHASH, CYN, CYN_SEED_SUBHASH, sha256hex(`${PROGRAMME}:am_seed_unlinked`)],
  );

  // real links (PH1-13/14 shape) for ada (Member) and cyn (Gold)
  await insertLink('lnk_00000000000000000000000ADA', 'usr_link_ada', ADA_MEMBER_REF, ADA_LINK_SUBHASH);
  await insertLink('lnk_00000000000000000000000CYN', 'usr_link_cyn', CYN_MEMBER_REF, CYN_LINK_SUBHASH);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('identity resolution over real IdentityLinks (PH1-15)', () => {
  it('an active link resolves T1 through wallet consumer_ref, agent sub_hash, AND member_ref', async () => {
    for (const consumer of [
      { consumer_ref: 'usr_link_ada' as never },
      { sub_hash: ADA_LINK_SUBHASH }, // walletless: agent-supplied sub_hash
      { member_ref: ADA_MEMBER_REF }, // walletless: agent-supplied member ref
    ]) {
      const resolved = resolve(consumer, await store.lookupsFor(consumer), clock);
      expect(resolved.tier).toBe('T1');
      expect(resolved.identity_ref).toBe(ADA_MEMBER_REF); // tokenised, never the raw sub
      expect(resolved.segment).toBe('t1-member-new');
    }
  });

  it('the member tier bridges from the demoted seeded fallback (Gold link → t1-gold)', async () => {
    const resolved = resolve({ sub_hash: CYN_LINK_SUBHASH }, await store.lookupsFor({ sub_hash: CYN_LINK_SUBHASH }), clock);
    expect(resolved).toMatchObject({ tier: 'T1', identity_ref: CYN_MEMBER_REF, segment: 't1-gold-new' });
  });

  it('revoking the link downgrades the SAME signal LIVE — the very next resolution is T3', async () => {
    const consumer = { sub_hash: ADA_LINK_SUBHASH };
    expect(resolve(consumer, await store.lookupsFor(consumer), clock).tier).toBe('T1');

    await pool.query(`UPDATE wallet.identity_links SET status = 'revoked' WHERE consumer_ref = 'usr_link_ada'`);
    // no cache: the next lookup already sees the revocation
    const downgraded = resolve(consumer, await store.lookupsFor(consumer), clock);
    expect(downgraded.tier).toBe('T3');

    // and the link is AUTHORITATIVE: even though the seeded ada row is still
    // active, the revoked link governs — no silent fallback to T1
    await pool.query(`UPDATE wallet.identity_links SET status = 'active' WHERE consumer_ref = 'usr_link_ada'`);
    expect(resolve(consumer, await store.lookupsFor(consumer), clock).tier).toBe('T1');
  });

  it('an unlinked seeded member still resolves T1 via the Phase-0 fallback (unchanged)', async () => {
    const consumer = { sub_hash: sha256hex(`${PROGRAMME}:am_seed_unlinked`) };
    const resolved = resolve(consumer, await store.lookupsFor(consumer), clock);
    expect(resolved).toMatchObject({ tier: 'T1', identity_ref: 'am_seed_unlinked', segment: 't1-gold-new' });
  });

  it('an unknown signal with no link and no seeded row is T3', async () => {
    const consumer = { sub_hash: 'no-link-no-seed' };
    expect(resolve(consumer, await store.lookupsFor(consumer), clock).tier).toBe('T3');
  });
});
