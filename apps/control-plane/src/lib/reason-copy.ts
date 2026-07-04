import { REJECTION_REASON_CODES, type RejectionReasonCode } from '@merited/contracts';

/**
 * MER-10: every §3 reason code with a one-line UK-English explanation —
 * "merchants … see why" as copy, not codes alone. The coverage test fails
 * if a code is ever added to contracts without a line here.
 */
export const REASON_COPY: Record<RejectionReasonCode, string> = {
  SIG_INVALID: 'The claim signature did not verify against the custodied merchant key.',
  TOKEN_REPLAYED: 'This attribution token has already been redeemed.',
  WINDOW_EXPIRED: 'The order fell outside the attribution window agreed in the commitment.',
  COMMITMENT_ENDED: 'The commitment behind this offer had ended before the order was placed.',
  CAP_EXHAUSTED: 'The commitment’s conversion cap had already been reached.',
  TIER_INELIGIBLE: 'The customer’s identity tier is not eligible under the commitment’s terms.',
  BUDGET_EXHAUSTED: 'The offer’s budget had been spent before this conversion.',
  MANDATE_REVOKED: 'The consumer revoked the mandate before this claim was made.',
  QUOTE_EXPIRED: 'The quote had lapsed before the order was placed — prices are promises with deadlines.',
  APPROVAL_MISSING: 'The token was minted under a mandate but no consumer approval was recorded.',
  APPROVAL_EXPIRED: 'The consumer’s approval expired with its quote before the order was placed.',
  LIMIT_EXCEEDED: 'The order breached the mandate’s spending limits.',
};

export const explain = (code: string): string =>
  (REASON_COPY as Record<string, string>)[code] ?? 'No explanation is available for this code.';

export const ALL_REASON_CODES = REJECTION_REASON_CODES;
