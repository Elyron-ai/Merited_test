import { z } from 'zod';
import { Approval } from '../approval.js';
import { Id } from '../ids.js';
import { Money } from '../money.js';
import { RejectionReasonCode } from '../reasons.js';

/**
 * Valet errand contracts (VAL-1, §6.6/B18). The state machine's TYPES live
 * here — packages/contracts is the ONLY definition site (repo-wide grep in
 * CI) — while the pure reducer over them is `apps/valet`'s (VAL-2). States
 * and events follow architecture §4.3's diagram exactly.
 */

/** The FULL state set — including the Phase-2 wallet-approval states, so
 * the reducer's matrix is total from day one (walletless Phase 0 simply
 * routes QUOTED → APPROVED via D4's skip path). */
export const ErrandState = z.enum([
  'BRIEFED',
  'SEARCHING',
  'QUOTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'CONFIRMED',
  'FAILED',
  'DECLINED',
  'EXPIRED',
]);
export type ErrandState = z.infer<typeof ErrandState>;

/**
 * Everything that can happen to an errand, as data. No I/O and no clock in
 * the reducer (VAL-2): timeouts arrive as `TIMED_OUT` events dispatched by
 * the driver's watchdog, with a free-text cause for the audit trail.
 */
export const ErrandEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SEARCH_STARTED') }),
  z.object({
    type: z.literal('QUOTE_RECEIVED'),
    quote_id: Id('qte'),
    /** Opaque attribution token; `null` for unregistered/degraded reads. */
    token: z.string().nullable(),
  }),
  z.object({ type: z.literal('APPROVAL_REQUESTED') }),
  z.object({
    type: z.literal('APPROVAL_GRANTED'),
    approval_id: Id('apr'),
    mode: Approval.shape.mode,
    /** PH2-4: the RE-MINTED `apr`-bearing token (same qid, fresh jti) the
     * errand must carry to checkout — the pre-approval token has apr:null
     * and dies APPROVAL_MISSING at verify (§6.4). Null on legacy events. */
    token: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal('APPROVAL_SKIPPED'), reason: z.string().min(1) }),
  z.object({ type: z.literal('APPROVAL_DECLINED') }),
  z.object({ type: z.literal('EXECUTION_STARTED') }),
  z.object({ type: z.literal('CLAIM_VERIFIED'), claim_id: Id('clm') }),
  z.object({ type: z.literal('CLAIM_REJECTED'), reason_code: RejectionReasonCode }),
  z.object({ type: z.literal('TIMED_OUT'), cause: z.string().min(1) }),
  z.object({ type: z.literal('RETRY') }),
  z.object({ type: z.literal('SEARCH_FAILED') }),
]);
export type ErrandEvent = z.infer<typeof ErrandEvent>;

/** The consumer's ask, as a contract object (VAL-7's CLI accepts it and a
 * Phase-2 wallet-originated brief reuses it unchanged). */
export const Brief = z.object({
  text: z.string().min(1),
  /** Budget ceiling in integer pence; null = no ceiling given. */
  max_price: Money.nullable(),
  /** Seeded-T1 handle (§5.3); null = anonymous/T3 acquisition read. */
  sub_hash: z.string().nullable(),
});
export type Brief = z.infer<typeof Brief>;

const datetime = z.string().datetime();

/** The persisted errand record (VAL-3 stores it beside its current state
 * and event log; BRIEFED/SEARCHING stay wallet-DB-only per §3). */
export const Errand = z.object({
  errand_id: Id('ern'),
  agent_id: Id('agt'),
  brief: Brief,
  mandate_id: Id('mnd').nullable(),
  approval_id: Id('apr').nullable(),
  consumer_ref: z.string().nullable(),
  sub_hash: z.string().nullable(),
  quote_id: Id('qte').nullable(),
  /** Opaque attribution token string — never decoded by Valet itself. */
  token: z.string().nullable(),
  claim_id: Id('clm').nullable(),
  created_at: datetime,
  updated_at: datetime,
});
export type Errand = z.infer<typeof Errand>;
