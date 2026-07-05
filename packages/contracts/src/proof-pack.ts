import { z } from 'zod';
import { ConversionClaim } from './claim.js';
import { Commitment } from './commitment.js';
import { HeadPublication } from './head-publication.js';

/**
 * The conversion proof pack (PH3-7 §9, docs/spec/verification.md): the exact
 * bundle a third party needs to verify one conversion OFFLINE — published
 * heads + the COR + the signed claim + convenience key copies + a contiguous
 * ledger slice anchored at a published head. The reference verifier
 * (packages/verifier, PH3-8) consumes exactly this shape.
 */
export const PROOF_PACK_FORMAT = 'merited-proof-pack/1';

export const ProofPackEventRow = z.object({
  seq: z.number().int().positive(),
  type: z.string().min(1),
  /** The HASHED body `{type, v, data}` exactly as chained. */
  body: z.unknown(),
  prev_hash: z.string().regex(/^[0-9a-f]{64}$/),
  this_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ProofPackEventRow = z.infer<typeof ProofPackEventRow>;

export const ProofPack = z.object({
  format: z.literal(PROOF_PACK_FORMAT),
  heads: z.array(HeadPublication).min(1),
  cor: Commitment,
  claim: ConversionClaim,
  keys: z.object({
    /** base64 SPKI DER, Ed25519 (spec §2). */
    platform_mint_public_key: z.string().min(1),
    platform_commitment_public_key: z.string().min(1),
    merchant_public_key: z.string().min(1),
  }),
  events: z.array(ProofPackEventRow).min(1),
});
export type ProofPack = z.infer<typeof ProofPack>;
