import { describe, expect, it } from 'vitest';
import { REJECTION_REASON_CODES, RejectionReasonCode } from './reasons.js';

describe('RejectionReasonCode (FND-3 accept)', () => {
  it('has exactly the twelve §3 codes (meta-test so additions are deliberate)', () => {
    expect(REJECTION_REASON_CODES).toHaveLength(12);
    expect([...REJECTION_REASON_CODES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('parses each code and rejects unknowns', () => {
    for (const code of REJECTION_REASON_CODES) {
      expect(RejectionReasonCode.parse(code)).toBe(code);
    }
    expect(RejectionReasonCode.safeParse('TOKEN_ABSENT').success).toBe(false);
    expect(RejectionReasonCode.safeParse('sig_invalid').success).toBe(false);
  });
});
