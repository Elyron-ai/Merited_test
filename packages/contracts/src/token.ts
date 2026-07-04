import { z } from 'zod';
import { Id } from './ids.js';
import { IdentityTier } from './tier.js';

/**
 * Attribution Token claims (PASETO v4.public payload) — quote-bound, v1.1
 * (BUILD-SPEC §3). `apr` is the approval ref on the wallet path, null on the
 * walletless path.
 */
export const AttributionTokenClaims = z.object({
  jti: Id('atk'),
  cid: Id('com'),
  qid: Id('qte'),
  aid: Id('agt'),
  tier: IdentityTier,
  sid: z.string(), // sha256(session_nonce)
  apr: Id('apr').nullable(),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AttributionTokenClaims = z.infer<typeof AttributionTokenClaims>;
