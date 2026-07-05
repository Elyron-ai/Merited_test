import { z } from 'zod';
import { Approval } from './approval.js';
import { Id } from './ids.js';

/**
 * Approval requests (PH2-4, §6.6/§6.4): the agent↔wallet rendezvous for the
 * live approval loop. An agent holding a quote minted under a mandate asks
 * the WALLET for approval; the wallet either records the implicit approval
 * (quote ≤ `pre_authorised_up_to` — no consumer interaction, arch §4.3) or
 * pushes a notification and leaves the request pending until the consumer
 * decides. Requesting grants nothing — the mandate holder decides (P3).
 */
export const ApprovalRequestCreate = z.object({
  quote_id: Id('qte'),
  mandate_id: Id('mnd'),
});
export type ApprovalRequestCreate = z.infer<typeof ApprovalRequestCreate>;

export const ApprovalRequestStatus = z.object({
  quote_id: Id('qte'),
  /** refused = the mandate could never authorise this quote (revoked,
   * scope missing, over per-txn limit, quote gone) — terminal. */
  status: z.enum(['pending', 'approved', 'declined', 'expired', 'refused']),
  reason: z.string().nullable(),
  mode: Approval.shape.mode.nullable(),
  approval_id: Id('apr').nullable(),
  /** The re-minted `apr`-bearing token (same qid, fresh jti) — the ONLY
   * token that survives approval-demanding verification (§6.4). */
  token: z.string().nullable(),
});
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatus>;
