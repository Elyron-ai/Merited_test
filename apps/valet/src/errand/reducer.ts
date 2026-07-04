import type { ErrandEvent, ErrandState } from '@merited/contracts';

/**
 * The errand state machine as a PURE reducer (VAL-2, §6.6/arch §4.3).
 * No I/O, no clock, no randomness — timeouts arrive as `TIMED_OUT` events
 * dispatched by the driver's watchdog (VAL-6), so every transition is
 * replayable from the event log alone.
 */
export type TransitionResult = { next: ErrandState } | { error: 'INVALID_TRANSITION' };

/**
 * The §4.3 diagram as data — one row per state, one entry per event that
 * state accepts. Everything absent is an explicit rejection. Notes:
 * - QUOTED accepts APPROVAL_SKIPPED (D4's walletless skip) AND a direct
 *   APPROVAL_GRANTED (a pre-authorised mandate records an implicit
 *   Approval without ever entering AWAITING_APPROVAL — arch §4.3).
 * - Timeouts before execution expire the errand with its quote; timeouts
 *   DURING execution are failures, and FAILED --RETRY--> EXECUTING is the
 *   one retry edge (the checkout rail is idempotent per §8, so re-entering
 *   EXECUTING never double-buys).
 * - CONFIRMED, DECLINED and EXPIRED are terminal.
 */
const TRANSITIONS: Readonly<Record<ErrandState, Partial<Record<ErrandEvent['type'], ErrandState>>>> = {
  BRIEFED: { SEARCH_STARTED: 'SEARCHING' },
  SEARCHING: {
    QUOTE_RECEIVED: 'QUOTED',
    SEARCH_FAILED: 'FAILED',
    TIMED_OUT: 'FAILED',
  },
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
  APPROVED: {
    EXECUTION_STARTED: 'EXECUTING',
    TIMED_OUT: 'EXPIRED',
  },
  EXECUTING: {
    CLAIM_VERIFIED: 'CONFIRMED',
    CLAIM_REJECTED: 'FAILED',
    TIMED_OUT: 'FAILED',
  },
  FAILED: { RETRY: 'EXECUTING' },
  CONFIRMED: {},
  DECLINED: {},
  EXPIRED: {},
};

export const transition = (state: ErrandState, event: ErrandEvent): TransitionResult => {
  const next = TRANSITIONS[state][event.type];
  return next ? { next } : { error: 'INVALID_TRANSITION' };
};

/** Terminal states — the driver stops watching once one is reached. */
export const isTerminal = (state: ErrandState): boolean =>
  Object.keys(TRANSITIONS[state]).length === 0;
