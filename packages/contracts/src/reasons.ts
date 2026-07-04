import { z } from 'zod';

/**
 * Claim rejection reason codes — exactly the twelve of BUILD-SPEC §3,
 * first-class data surfaced to both merchants and agents. The enum is
 * closed (SYN-10, SYN-27): additions are a deliberate contracts-first PR.
 */
export const REJECTION_REASON_CODES = [
  'SIG_INVALID',
  'TOKEN_REPLAYED',
  'WINDOW_EXPIRED',
  'COMMITMENT_ENDED',
  'CAP_EXHAUSTED',
  'TIER_INELIGIBLE',
  'BUDGET_EXHAUSTED',
  'MANDATE_REVOKED',
  'QUOTE_EXPIRED',
  'APPROVAL_MISSING',
  'APPROVAL_EXPIRED',
  'LIMIT_EXCEEDED',
] as const;

export const RejectionReasonCode = z.enum(REJECTION_REASON_CODES);
export type RejectionReasonCode = z.infer<typeof RejectionReasonCode>;
