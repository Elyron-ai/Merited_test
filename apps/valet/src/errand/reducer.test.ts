import { ErrandEvent, ErrandState } from '@merited/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isTerminal, transition, type TransitionResult } from './reducer.js';

/** Minimal valid payload for each event type (payloads never affect the
 * transition — asserted by the property test below). */
const EVENT_OF: Record<ErrandEvent['type'], ErrandEvent> = {
  SEARCH_STARTED: { type: 'SEARCH_STARTED' },
  QUOTE_RECEIVED: { type: 'QUOTE_RECEIVED', quote_id: 'qte_01J00000000000000000000000', token: null },
  APPROVAL_REQUESTED: { type: 'APPROVAL_REQUESTED' },
  APPROVAL_GRANTED: { type: 'APPROVAL_GRANTED', approval_id: 'apr_01J00000000000000000000000', mode: 'explicit' },
  APPROVAL_SKIPPED: { type: 'APPROVAL_SKIPPED', reason: 'walletless' },
  APPROVAL_DECLINED: { type: 'APPROVAL_DECLINED' },
  EXECUTION_STARTED: { type: 'EXECUTION_STARTED' },
  CLAIM_VERIFIED: { type: 'CLAIM_VERIFIED', claim_id: 'clm_01J00000000000000000000000' },
  CLAIM_REJECTED: { type: 'CLAIM_REJECTED', reason_code: 'TOKEN_REPLAYED' },
  TIMED_OUT: { type: 'TIMED_OUT', cause: 'watchdog' },
  RETRY: { type: 'RETRY' },
  SEARCH_FAILED: { type: 'SEARCH_FAILED' },
};

const EVENT_TYPES = Object.keys(EVENT_OF) as ErrandEvent['type'][];

/** The COMPLETE expected matrix — §4.3's diagram plus the row's named
 * edges (D4 skip, FAILED --RETRY--> EXECUTING). Cells absent here must
 * be explicit rejections. */
const EXPECTED: Record<ErrandState, Partial<Record<ErrandEvent['type'], ErrandState>>> = {
  BRIEFED: { SEARCH_STARTED: 'SEARCHING' },
  SEARCHING: { QUOTE_RECEIVED: 'QUOTED', SEARCH_FAILED: 'FAILED', TIMED_OUT: 'FAILED' },
  QUOTED: {
    APPROVAL_REQUESTED: 'AWAITING_APPROVAL',
    APPROVAL_SKIPPED: 'APPROVED',
    APPROVAL_GRANTED: 'APPROVED',
    TIMED_OUT: 'EXPIRED',
  },
  AWAITING_APPROVAL: {
    APPROVAL_GRANTED: 'APPROVED',
    APPROVAL_DECLINED: 'DECLINED',
    TIMED_OUT: 'EXPIRED',
  },
  APPROVED: { EXECUTION_STARTED: 'EXECUTING', TIMED_OUT: 'EXPIRED' },
  EXECUTING: { CLAIM_VERIFIED: 'CONFIRMED', CLAIM_REJECTED: 'FAILED', TIMED_OUT: 'FAILED' },
  FAILED: { RETRY: 'EXECUTING' },
  CONFIRMED: {},
  DECLINED: {},
  EXPIRED: {},
};

describe('errand reducer (VAL-2 accept — exhaustive transition tests)', () => {
  it('the COMPLETE states × events matrix: every cell a defined transition or an explicit rejection', () => {
    // generated from the enums, never hand-listed — adding a state or event
    // without extending EXPECTED fails this test by construction
    expect(Object.keys(EXPECTED).sort()).toEqual([...ErrandState.options].sort());
    expect(new Set(EVENT_TYPES)).toEqual(new Set(ErrandEvent.options.map((o) => o.shape.type.value)));

    const seen: Array<[ErrandState, ErrandEvent['type'], TransitionResult]> = [];
    for (const state of ErrandState.options) {
      for (const eventType of EVENT_TYPES) {
        const result = transition(state, EVENT_OF[eventType]);
        seen.push([state, eventType, result]);
        const expected = EXPECTED[state][eventType];
        if (expected) {
          expect(result, `${state} × ${eventType}`).toEqual({ next: expected });
        } else {
          expect(result, `${state} × ${eventType}`).toEqual({ error: 'INVALID_TRANSITION' });
        }
      }
    }
    expect(seen).toHaveLength(ErrandState.options.length * EVENT_TYPES.length); // 100% of pairs
  });

  it('the demo paths walk end-to-end: walletless skip (D4), wallet approval, and retry-after-failure', () => {
    const walk = (start: ErrandState, events: ErrandEvent['type'][]): ErrandState =>
      events.reduce<ErrandState>((state, type) => {
        const result = transition(state, EVENT_OF[type]);
        if ('error' in result) throw new Error(`${state} × ${type} rejected`);
        return result.next;
      }, start);

    expect(walk('BRIEFED', ['SEARCH_STARTED', 'QUOTE_RECEIVED', 'APPROVAL_SKIPPED', 'EXECUTION_STARTED', 'CLAIM_VERIFIED'])).toBe('CONFIRMED');
    expect(walk('BRIEFED', ['SEARCH_STARTED', 'QUOTE_RECEIVED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'EXECUTION_STARTED', 'CLAIM_REJECTED', 'RETRY', 'CLAIM_VERIFIED'])).toBe('CONFIRMED');
    expect(walk('QUOTED', ['APPROVAL_REQUESTED', 'APPROVAL_DECLINED'])).toBe('DECLINED');
    expect(walk('AWAITING_APPROVAL', ['TIMED_OUT'])).toBe('EXPIRED');
  });

  it('CONFIRMED, DECLINED and EXPIRED are terminal; nothing else is', () => {
    for (const state of ErrandState.options) {
      expect(isTerminal(state), state).toBe(['CONFIRMED', 'DECLINED', 'EXPIRED'].includes(state));
    }
  });

  it('property: total, pure and payload-independent — same cell → same output, no mutation, never a throw', () => {
    const eventArb: fc.Arbitrary<ErrandEvent> = fc
      .constantFrom(...EVENT_TYPES)
      .chain((type) =>
        fc.record({
          payloadSeed: fc.string({ maxLength: 30 }).filter((s) => s.length > 0),
        }).map(({ payloadSeed }): ErrandEvent => {
          const base = EVENT_OF[type];
          // vary the free-text payload fields; typed fields stay valid
          if (base.type === 'APPROVAL_SKIPPED') return { ...base, reason: payloadSeed };
          if (base.type === 'TIMED_OUT') return { ...base, cause: payloadSeed };
          return { ...base };
        }),
      );

    fc.assert(
      fc.property(fc.constantFrom(...ErrandState.options), eventArb, (state, event) => {
        const frozen = Object.freeze({ ...event }) as ErrandEvent;
        const first = transition(state, frozen);
        const second = transition(state, frozen);
        expect(second).toEqual(first); // deterministic
        expect(first).toEqual(transition(state, EVENT_OF[event.type])); // payload-independent
        expect(Object.isFrozen(frozen)).toBe(true); // no mutation possible
      }),
      { numRuns: 500 },
    );
  });
});
