import { Segment, type ConsumerCtx } from '@merited/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  resolve,
  segmentFor,
  type AuroraMemberRecord,
  type IdentityLookupResults,
} from './resolve.js';

const clock = { now: () => new Date('2026-07-04T12:00:00Z') };

const memberArb = (status?: 'active' | 'revoked'): fc.Arbitrary<AuroraMemberRecord> =>
  fc.record({
    member_ref: fc.stringMatching(/^AUR-[0-9]{4}$/),
    sub_hash: fc.stringMatching(/^[0-9a-f]{8}$/),
    loyalty_tier: fc.constantFrom('Member', 'Gold') as fc.Arbitrary<'Member' | 'Gold'>,
    status: status ? fc.constant(status) : fc.constantFrom('active', 'revoked') as fc.Arbitrary<'active' | 'revoked'>,
    consumer_ref: fc.option(fc.stringMatching(/^usr_[0-9A-HJKMNP-TV-Z]{4}$/), { nil: null }),
  });

const softIdentityArb = fc
  .record({
    hash: fc.stringMatching(/^[0-9a-f]{16}$/),
    first_seen_at: fc.constantFrom('2026-06-01T00:00:00Z', '2026-07-01T09:30:00Z'),
    seenAgain: fc.boolean(),
  })
  .map(({ hash, first_seen_at, seenAgain }) => ({
    hash,
    first_seen_at,
    last_seen_at: seenAgain ? '2026-07-03T18:00:00Z' : first_seen_at,
  }));

const lookupsArb: fc.Arbitrary<IdentityLookupResults> = fc.record({
  member_by_consumer_ref: fc.option(memberArb(), { nil: null }),
  member_by_sub_hash: fc.option(memberArb(), { nil: null }),
  member_by_member_ref: fc.option(memberArb(), { nil: null }),
  soft_identity: fc.option(softIdentityArb, { nil: null }),
});

const consumerArb: fc.Arbitrary<ConsumerCtx> = fc.record({
  sub_hash: fc.stringMatching(/^[0-9a-f]{8}$/),
});

describe('identity resolution properties (CORE-4 accept, §5.3 verbatim)', () => {
  it('(1) any input containing an ACTIVE member match resolves T1, regardless of what else is present', () => {
    fc.assert(
      fc.property(
        consumerArb,
        lookupsArb,
        memberArb('active'),
        fc.constantFrom('member_by_consumer_ref', 'member_by_sub_hash', 'member_by_member_ref'),
        (consumer, lookups, activeMember, slot) => {
          const withActive = { ...lookups, [slot]: activeMember };
          const resolved = resolve(consumer, withActive, clock);
          expect(resolved.tier).toBe('T1');
          expect(resolved.identity_ref).not.toBeNull();
          expect(resolved.segment.startsWith('t1-')).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('(2) flipping every member row to revoked downgrades the SAME input to T2/T3 immediately', () => {
    fc.assert(
      fc.property(consumerArb, lookupsArb, memberArb('active'), (consumer, lookups, activeMember) => {
        const withActive = { ...lookups, member_by_sub_hash: activeMember };
        expect(resolve(consumer, withActive, clock).tier).toBe('T1');

        const revoke = (m: AuroraMemberRecord | null): AuroraMemberRecord | null =>
          m ? { ...m, status: 'revoked' } : null;
        const revoked: IdentityLookupResults = {
          member_by_consumer_ref: revoke(withActive.member_by_consumer_ref),
          member_by_sub_hash: revoke(withActive.member_by_sub_hash),
          member_by_member_ref: revoke(withActive.member_by_member_ref),
          soft_identity: withActive.soft_identity,
        };
        const downgraded = resolve(consumer, revoked, clock);
        expect(downgraded.tier).toBe(withActive.soft_identity ? 'T2' : 'T3');
      }),
      { numRuns: 500 },
    );
  });

  it('(3) resolve is referentially transparent: same input, 1000 runs, one distinct output', () => {
    const sample = fc.sample(fc.tuple(consumerArb, lookupsArb), { numRuns: 5, seed: 42 });
    for (const [consumer, lookups] of sample) {
      const outputs = new Set<string>();
      for (let run = 0; run < 1000; run += 1) {
        outputs.add(JSON.stringify(resolve(consumer, lookups, clock)));
      }
      expect(outputs.size).toBe(1);
    }
  });

  it('link beats hash: an active member match wins over a simultaneous soft-identity match', () => {
    fc.assert(
      fc.property(consumerArb, memberArb('active'), softIdentityArb, (consumer, member, soft) => {
        const resolved = resolve(
          consumer,
          {
            member_by_consumer_ref: null,
            member_by_sub_hash: member,
            member_by_member_ref: null,
            soft_identity: soft,
          },
          clock,
        );
        expect(resolved.tier).toBe('T1');
        expect(resolved.identity_ref).toBe(member.member_ref);
      }),
      { numRuns: 200 },
    );
  });

  it('no consumer context at all is always t3-acquisition', () => {
    fc.assert(
      fc.property(lookupsArb, (lookups) => {
        expect(resolve(undefined, lookups, clock)).toEqual({
          tier: 'T3',
          identity_ref: null,
          segment: 't3-acquisition',
        });
      }),
      { numRuns: 100 },
    );
  });

  it('segmentFor is the frozen contracts enum, exhaustively', () => {
    expect(segmentFor('T1', 'Gold', false)).toBe('t1-gold-new');
    expect(segmentFor('T1', 'Gold', true)).toBe('t1-gold-returning');
    expect(segmentFor('T1', 'Member', false)).toBe('t1-member-new');
    expect(segmentFor('T1', 'Member', true)).toBe('t1-member-returning');
    expect(segmentFor('T2', null, false)).toBe('t2-new');
    expect(segmentFor('T2', null, true)).toBe('t2-returning');
    expect(segmentFor('T3', null, false)).toBe('t3-acquisition');
    // every produced segment parses against the frozen enum
    fc.assert(
      fc.property(consumerArb, lookupsArb, (consumer, lookups) => {
        expect(Segment.safeParse(resolve(consumer, lookups, clock).segment).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
