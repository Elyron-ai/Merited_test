import { z } from 'zod';
import { Id } from './ids.js';

/**
 * `readOffers()` inputs (BUILD-SPEC §4). AgentCtx comes from verified agent
 * auth — `agent_id: null` is the anonymous/degraded path (token: null +
 * register_to_earn). ConsumerCtx carries whichever identity signals the
 * caller has; all optional.
 */
export const AgentCtx = z.object({
  agent_id: Id('agt').nullable(),
});
export type AgentCtx = z.infer<typeof AgentCtx>;

export const ConsumerCtx = z.object({
  mandate_ref: Id('mnd').optional(),
  consumer_ref: Id('usr').optional(),
  sub_hash: z.string().optional(),
  member_ref: z.string().optional(),
  hashed_email: z.string().optional(),
});
export type ConsumerCtx = z.infer<typeof ConsumerCtx>;
