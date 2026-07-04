import { z } from 'zod';
import { Id } from './ids.js';

/**
 * Identity Link — OAuth-consented loyalty account, the T1 key (BUILD-SPEC §3).
 * NB (§3, §6.3 accept): refresh/access tokens are NOT on this object — they
 * live encrypted in the wallet backend's separate `link_tokens` table and are
 * never serialised into contracts or API responses.
 */
export const IdentityLink = z.object({
  link_id: Id('lnk'),
  consumer_ref: Id('usr'),
  merchant_id: Id('mer'),
  programme: z.string(),
  member_ref: z.string(), // tokenised member id
  sub_hash: z.string(), // sha256(idp subject)
  scopes: z.array(z.enum(['profile', 'balance', 'tier'])),
  status: z.enum(['active', 'revoked']),
  linked_at: z.string().datetime(),
});

export type IdentityLink = z.infer<typeof IdentityLink>;
