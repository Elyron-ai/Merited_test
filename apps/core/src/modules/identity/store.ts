import type { ConsumerCtx } from '@merited/contracts';
import type pg from 'pg';
import {
  EMPTY_LOOKUPS,
  type AuroraMemberRecord,
  type IdentityLookupResults,
  type SoftIdentityRecord,
} from './resolve.js';

// Full millisecond precision: resolve() distinguishes first vs repeat
// sightings by exact equality, and two sightings can share a second.
const isoS = (date: Date): string => date.toISOString();

interface MemberRow {
  member_ref: string;
  sub_hash: string;
  loyalty_tier: 'Member' | 'Gold';
  status: 'active' | 'revoked';
  consumer_ref: string | null;
}

/**
 * Identity IO (CORE-4): every lookup the pure `resolve()` needs, fetched
 * up front and passed in as data. Reads are live — no caching, so a
 * revocation lands on the very next resolution.
 */
export class IdentityStore {
  constructor(private readonly pool: pg.Pool) {}

  async lookupsFor(consumer: ConsumerCtx | undefined): Promise<IdentityLookupResults> {
    if (!consumer) return EMPTY_LOOKUPS;

    const memberBy = async (
      column: 'consumer_ref' | 'sub_hash' | 'member_ref',
      value: string | undefined,
    ): Promise<AuroraMemberRecord | null> => {
      if (!value) return null;
      const { rows } = await this.pool.query<MemberRow>(
        `SELECT member_ref, sub_hash, loyalty_tier, status, consumer_ref
           FROM core.aurora_club_members WHERE ${column} = $1
          ORDER BY member_ref LIMIT 1`,
        [value],
      );
      return rows[0] ?? null;
    };

    const softIdentity = async (): Promise<SoftIdentityRecord | null> => {
      if (!consumer.hashed_email) return null;
      const { rows } = await this.pool.query<{
        hash: string;
        first_seen_at: Date;
        last_seen_at: Date;
      }>(
        `SELECT hash, first_seen_at, last_seen_at FROM core.soft_identities WHERE hash = $1`,
        [consumer.hashed_email],
      );
      const row = rows[0];
      return row
        ? { hash: row.hash, first_seen_at: isoS(row.first_seen_at), last_seen_at: isoS(row.last_seen_at) }
        : null;
    };

    const [byConsumerRef, bySubHash, byMemberRef, soft] = await Promise.all([
      memberBy('consumer_ref', consumer.consumer_ref),
      memberBy('sub_hash', consumer.sub_hash),
      memberBy('member_ref', consumer.member_ref),
      softIdentity(),
    ]);
    return {
      member_by_consumer_ref: byConsumerRef,
      member_by_sub_hash: bySubHash,
      member_by_member_ref: byMemberRef,
      soft_identity: soft,
    };
  }

  /** Record a sighting of a hashed email (first_seen fixed, last_seen moves). */
  async touchSoftIdentity(hash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO core.soft_identities (hash) VALUES ($1)
       ON CONFLICT (hash) DO UPDATE SET last_seen_at = now()`,
      [hash],
    );
  }
}
