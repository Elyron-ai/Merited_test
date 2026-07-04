import { z } from 'zod';
import { MintResponse } from './index.js';

/**
 * Typed mint-client failure surface (CORE-9, §7.2). Additive to the frozen
 * M1 shapes: the wire contract is untouched; this types how Core's
 * token-client reports it. NO RETRIES by design — a retried mint would
 * orphan a jti; on failure the quote ships with `token: null`.
 */
export const TrioMintErrorCode = z.enum([
  // trio error-body codes, §7.2 mint guards
  'COMMITMENT_NOT_FOUND',
  'COMMITMENT_NOT_LIVE',
  'QUOTE_EXPIRY_EXCEEDS_TOKEN',
  'VALIDATION_FAILED',
  'SERVICE_AUTH_FAILED',
  // client-side outcomes
  'TIMEOUT',
  'NETWORK_ERROR',
  'UNEXPECTED_RESPONSE',
]);
export type TrioMintErrorCode = z.infer<typeof TrioMintErrorCode>;

export const MintFailure = z.object({
  code: TrioMintErrorCode,
  message: z.string(),
});
export type MintFailure = z.infer<typeof MintFailure>;

export const MintResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), minted: MintResponse }),
  z.object({ ok: z.literal(false), error: MintFailure }),
]);
export type MintResult = z.infer<typeof MintResult>;
