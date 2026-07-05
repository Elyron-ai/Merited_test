import type { ConsumerCtx } from '@merited/contracts';
import type pg from 'pg';
import {
  EMPTY_LOOKUPS,
  type AuroraMemberRecord,
  type IdentityLookupResults,
  type SoftIdentityRecord,
} from './resolve.js';
import type { IdentityLinkReader } from './link-reader.js';

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
 * Identity IO (CORE-4, upgraded PH1-15): every lookup the pure `resolve()`
 * needs, fetched up front and passed in as data. Reads are live — no caching,
 * so a revocation lands on the very next resolution.
 *
 * PH1-15 promotes the real B23 IdentityLink (PH1-13/14) to the PRIMARY T1
 * source: for each identity signal an active link resolves T1, and its status
 * is authoritative — a revoked link downgrades immediately, even if a Phase-0
 * seeded row for the same signal is still active. The Phase-0 seeded Aurora
 * table demotes to the LoyaltyLookup-style FALLBACK: it stands in for members
 * with no real link, and it supplies the member TIER for a linked member
 * (bridged via the tokenised member_ref). With no `linkReader` injected the
 * store behaves exactly as it did in Phase 0.
 */
export class IdentityStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly linkReader?: IdentityLinkReader,
  ) {}

  async lookupsFor(consumer: ConsumerCtx | undefined): Promise<IdentityLookupResults> {
    if (!consumer) return EMPTY_LOOKUPS;

    const seededBy = async (
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

    /**
     * PRIMARY: an active-or-revoked B23 link is authoritative for its signal.
     * The tier comes from the seeded fallback via the tokenised member_ref
     * (`mbr_<sha256(programme:sub)[:24]>` shares its 24-hex prefix with the
     * seeded `sub_hash = sha256(programme:sub)`), defaulting to Member for a
     * real partner member absent from the Phase-0 table.
     */
    const linkBy = async (
      column: 'consumer_ref' | 'sub_hash' | 'member_ref',
      value: string | undefined,
    ): Promise<AuroraMemberRecord | null> => {
      if (!value || !this.linkReader) return null;
      const link = await this.linkReader.linkBy(column, value);
      if (!link) return null;
      return {
        member_ref: link.member_ref,
        sub_hash: link.sub_hash,
        loyalty_tier: await this.tierForLinkedMember(link.member_ref),
        status: link.status,
        consumer_ref: link.consumer_ref,
      };
    };

    // link is authoritative; only when no link exists does the seeded row apply
    const memberBy = async (
      column: 'consumer_ref' | 'sub_hash' | 'member_ref',
      value: string | undefined,
    ): Promise<AuroraMemberRecord | null> => (await linkBy(column, value)) ?? seededBy(column, value);

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

  /**
   * The member tier for a linked member, from the seeded Aurora fallback
   * (PH1-15's demoted Phase-0 table). The link's tokenised member_ref
   * (`mbr_<token>`) shares its 24-hex `token` with the seeded `sub_hash`
   * prefix for the same subject, so we bridge on that. A real partner member
   * with no seeded row defaults to `Member` — the base tier, never an inflated
   * one. (Phase 2 swaps this for a live LoyaltyLookup once a resolvable member
   * key is available.)
   */
  private async tierForLinkedMember(memberRef: string): Promise<'Member' | 'Gold'> {
    if (!memberRef.startsWith('mbr_')) return 'Member';
    const token = memberRef.slice(4);
    const { rows } = await this.pool.query<{ loyalty_tier: 'Member' | 'Gold' }>(
      `SELECT loyalty_tier FROM core.aurora_club_members
        WHERE left(sub_hash, 24) = $1 LIMIT 1`,
      [token],
    );
    return rows[0]?.loyalty_tier ?? 'Member';
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
