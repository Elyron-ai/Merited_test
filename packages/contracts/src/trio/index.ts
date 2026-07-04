import { z } from 'zod';
import { Commitment } from '../commitment.js';
import { ConversionClaim } from '../claim.js';
import { Id } from '../ids.js';
import { Money } from '../money.js';
import { RejectionReasonCode } from '../reasons.js';
import { IdentityTier } from '../tier.js';
import { AttributionTokenClaims } from '../token.js';

/**
 * Trio wire contracts (TRIO-1; BUILD-SPEC §7; architecture §2). Frozen at M1
 * (XC-7): any post-freeze change is a contracts-first PR with recorded
 * high-scrutiny review + version bump. The simulators (TRIO-4…11) and the
 * Phase-1 real implementations (PH1-24…26) serve EXACTLY these shapes —
 * the unchanged contract suite is the acceptance gate (zero-edit rule).
 */

const datetime = z.string().datetime();

// ── §7.1 Commitment Signing ─────────────────────────────────────────────────

/**
 * Unsigned draft in → countersigned COR out. `budget` is optional (SYN-12):
 * it registers a spend counter in Settlement; the COR itself stays immutable
 * and budget-free (counters live outside it — architecture §2.2).
 */
export const CommitmentDraft = z.object({
  merchant_id: Id('mer'),
  offer_ref: Id('off'),
  bounty: z.object({
    type: z.enum(['fixed', 'pct_of_order']),
    amount: Money.optional(),
    pct_bps: z.number().int().positive().optional(),
  }),
  take_rate_bps: z.number().int().nonnegative(),
  agent_commission_bps: z.number().int().nonnegative(),
  terms: z.object({
    attribution_window_s: z.number().int().positive(),
    eligible_identity_tiers: z.array(IdentityTier),
    max_conversions: z.number().int().positive().nullable(),
    clawback_window_s: z.number().int().nonnegative(),
    valid_from: datetime,
    valid_until: datetime,
  }),
  budget: Money.optional(),
});
export type CommitmentDraft = z.infer<typeof CommitmentDraft>;

export const CommitmentCreateResponse = z.object({ commitment: Commitment });
export type CommitmentCreateResponse = z.infer<typeof CommitmentCreateResponse>;

export const CommitmentEndRequest = z.object({ reason: z.string().optional() });
export type CommitmentEndRequest = z.infer<typeof CommitmentEndRequest>;

export const CommitmentEndResponse = z.object({
  commitment_id: Id('com'),
  ended_at: datetime,
});
export type CommitmentEndResponse = z.infer<typeof CommitmentEndResponse>;

/**
 * Commitment status read (SYN-7 — additive to §7.1's POSTs): consumed by
 * eligibility's liveness + cap check (CORE-6).
 */
export const CommitmentStatus = z.object({
  commitment_id: Id('com'),
  status: z.enum(['live', 'ended', 'expired', 'not_yet_valid']),
  conversions_used: z.number().int().nonnegative(),
  max_conversions: z.number().int().positive().nullable(),
  budget_remaining: Money.nullable(),
});
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

// ── §7.2 Token Mint + Conversion Verification ───────────────────────────────

/**
 * Mint request (SYN-8): §7.2's literal input plus the quote snapshot —
 * `expires_at` enables the stage-4 QUOTE_EXPIRED check and `mandate_ref`
 * defines the wallet path at verification (snapshot mandate_ref + null apr
 * → APPROVAL_MISSING) without a runtime call back into Core.
 * Re-mint (B26): same qid, apr set → fresh jti.
 */
export const MintRequest = z.object({
  cid: Id('com'),
  qid: Id('qte'),
  aid: Id('agt'),
  tier: IdentityTier,
  session_nonce: z.string().min(1),
  apr: Id('apr').optional(),
  quote: z.object({
    expires_at: datetime,
    mandate_ref: Id('mnd').nullable(),
  }),
});
export type MintRequest = z.infer<typeof MintRequest>;

/** Response carries claims so downstream stays token-opaque (SYN-8). */
export const MintResponse = z.object({
  token: z.string(),
  claims: AttributionTokenClaims,
});
export type MintResponse = z.infer<typeof MintResponse>;

export const VerifyRequest = ConversionClaim;
export type VerifyRequest = z.infer<typeof VerifyRequest>;

/** Same shape as the LedgerEntryPosted event body's entry set (FND-7). */
export const EntryLine = z.object({
  account: z.string(),
  side: z.enum(['dr', 'cr']),
  amount: Money,
});
export type EntryLine = z.infer<typeof EntryLine>;

export const EntrySet = z
  .object({
    entry_set_id: z.string(),
    claim_id: Id('clm').nullable(),
    lines: z.array(EntryLine).min(2),
  })
  .superRefine((set, ctx) => {
    const total = (side: 'dr' | 'cr') =>
      set.lines.filter((l) => l.side === side).reduce((sum, l) => sum + l.amount.amount, 0);
    if (total('dr') !== total('cr')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: `entry set does not balance: dr ${total('dr')} ≠ cr ${total('cr')}`,
      });
    }
  });
export type EntrySet = z.infer<typeof EntrySet>;

/**
 * First-failure-wins verdict (§7.2 pipeline order; SYN-9 replay semantics:
 * jti consumed only on verified; one verified conversion per qid).
 */
export const VerifyResponse = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('verified'), entries_preview: EntrySet }),
  z.object({ verdict: z.literal('rejected'), reason_code: RejectionReasonCode }),
]);
export type VerifyResponse = z.infer<typeof VerifyResponse>;

// ── §7.3 Net Settlement ──────────────────────────────────────────────────────

/** Clawback (SYN-10: within clawback_window_s; reversal frees the cap). */
export const ReverseRequest = z.object({
  claim_id: Id('clm'),
  merchant_id: Id('mer'),
  reason: z.string().optional(),
  merchant_sig: z.string(),
});
export type ReverseRequest = z.infer<typeof ReverseRequest>;

export const ReverseResponse = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('reversed'), entries_preview: EntrySet }),
  z.object({ verdict: z.literal('rejected'), reason_code: RejectionReasonCode }),
]);
export type ReverseResponse = z.infer<typeof ReverseResponse>;

export const Balance = z.object({
  direction: z.enum(['payable', 'receivable']),
  amount: Money,
});
export type Balance = z.infer<typeof Balance>;

export const Position = Balance.extend({ party: z.string() });
export type Position = z.infer<typeof Position>;

export const NettingRunRequest = z.object({ period: z.string() });
export type NettingRunRequest = z.infer<typeof NettingRunRequest>;

export const NettingRunResult = z.object({
  netting_run_id: z.string(),
  period: z.string(),
  positions: z.array(Position),
});
export type NettingRunResult = z.infer<typeof NettingRunResult>;

export const StatementLine = z.object({
  seq: z.number().int().positive(),
  description: z.string(),
  side: z.enum(['dr', 'cr']),
  amount: Money,
});
export type StatementLine = z.infer<typeof StatementLine>;

/** A netting run's fold for this party, as it appears on a statement. */
export const NettingEventRef = z.object({
  netting_run_id: z.string(),
  at: datetime,
  position: Balance,
});
export type NettingEventRef = z.infer<typeof NettingEventRef>;

export const Statement = z.object({
  party: z.string(),
  period: z.string(),
  opening: Balance,
  lines: z.array(StatementLine),
  netting_events: z.array(NettingEventRef),
  closing: Balance,
});
export type Statement = z.infer<typeof Statement>;

// ── Service interfaces (simulators + PH1-24…26 implement these) ────────────

export interface CommitmentSigningService {
  create(draft: CommitmentDraft): Promise<CommitmentCreateResponse>;
  end(commitmentId: string, request: CommitmentEndRequest): Promise<CommitmentEndResponse>;
  status(commitmentId: string): Promise<CommitmentStatus>;
}

export interface TokenMintService {
  mint(request: MintRequest): Promise<MintResponse>;
}

export interface ConversionVerificationService {
  verify(claim: VerifyRequest, options: { idempotencyKey: string }): Promise<VerifyResponse>;
}

export interface SettlementService {
  reverse(request: ReverseRequest): Promise<ReverseResponse>;
  position(party: string): Promise<Position>;
  runNetting(request: NettingRunRequest): Promise<NettingRunResult>;
  statement(party: string, period: string): Promise<Statement>;
}
