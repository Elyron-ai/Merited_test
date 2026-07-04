import type { ConsumerCtx, IdentityTier, Segment } from '@merited/contracts';

/** Injected time source (§4: no ambient IO inside stage functions). Unused
 * by the Phase-0 rules but part of the stage signature from day one —
 * link-expiry semantics arrive with B23 (Phase 1). */
export interface Clock {
  now(): Date;
}

/** Row shape of the seeded Phase-0 T1 stand-in (schema CORE owns, rows
 * VAL-9 owns). `consumer_ref` links a member to a wallet consumer (B23). */
export interface AuroraMemberRecord {
  member_ref: string;
  sub_hash: string;
  loyalty_tier: 'Member' | 'Gold';
  status: 'active' | 'revoked';
  consumer_ref: string | null;
}

export interface SoftIdentityRecord {
  hash: string;
  first_seen_at: string;
  last_seen_at: string;
}

/** All IO happens in store.ts and arrives here as data (§5.3 — this is what
 * makes the function property-testable). One slot per identity signal. */
export interface IdentityLookupResults {
  member_by_consumer_ref: AuroraMemberRecord | null;
  member_by_sub_hash: AuroraMemberRecord | null;
  member_by_member_ref: AuroraMemberRecord | null;
  soft_identity: SoftIdentityRecord | null;
}

export const EMPTY_LOOKUPS: IdentityLookupResults = {
  member_by_consumer_ref: null,
  member_by_sub_hash: null,
  member_by_member_ref: null,
  soft_identity: null,
};

export interface ResolvedIdentity {
  tier: IdentityTier;
  identity_ref: string | null;
  segment: Segment;
}

/**
 * Deterministic categorisation (§5.3): `returning` is a pure function of the
 * soft-identity row — seen more than once (`first_seen_at ≠ last_seen_at`).
 * A T1 member who has never transacted through Merited is therefore `new`.
 */
export const segmentFor = (
  tier: IdentityTier,
  loyaltyTier: 'Member' | 'Gold' | null,
  returning: boolean,
): Segment => {
  if (tier === 'T1') {
    return `t1-${loyaltyTier === 'Gold' ? 'gold' : 'member'}-${returning ? 'returning' : 'new'}`;
  }
  if (tier === 'T2') return returning ? 't2-returning' : 't2-new';
  return 't3-acquisition';
};

/**
 * Identity resolution (CORE-4, B5/§5.3) — PURE. Precedence: the first
 * ACTIVE member match in signal order consumer_ref → sub_hash → member_ref
 * resolves T1 (link beats hash: any active member match wins over a
 * soft-identity hash match); else a hashed-email match resolves T2; else T3.
 * A `revoked` member row never resolves T1 — revocation downgrades on the
 * very next resolution (rehearses B23's live-downgrade semantics).
 */
export const resolve = (
  consumer: ConsumerCtx | undefined,
  lookups: IdentityLookupResults,
  _clock: Clock,
): ResolvedIdentity => {
  const returning =
    lookups.soft_identity !== null &&
    lookups.soft_identity.first_seen_at !== lookups.soft_identity.last_seen_at;

  if (consumer) {
    const candidates = [
      lookups.member_by_consumer_ref,
      lookups.member_by_sub_hash,
      lookups.member_by_member_ref,
    ];
    const active = candidates.find(
      (member): member is AuroraMemberRecord => member !== null && member.status === 'active',
    );
    if (active) {
      return {
        tier: 'T1',
        identity_ref: active.member_ref,
        segment: segmentFor('T1', active.loyalty_tier, returning),
      };
    }
    if (lookups.soft_identity) {
      return {
        tier: 'T2',
        identity_ref: lookups.soft_identity.hash,
        segment: segmentFor('T2', null, returning),
      };
    }
  }
  return { tier: 'T3', identity_ref: null, segment: segmentFor('T3', null, false) };
};
