import { z } from 'zod';
import { Approval } from '../approval.js';
import { Commitment } from '../commitment.js';
import { Id } from '../ids.js';
import { IdentityLink } from '../identity-link.js';
import { Mandate } from '../mandate.js';
import { Money } from '../money.js';
import { RejectionReasonCode } from '../reasons.js';
import { IdentityTier } from '../tier.js';
import { AttributionTokenClaims } from '../token.js';
import { eventBody } from './envelope.js';

/**
 * The 20 catalogue events (BUILD-SPEC §3 nineteen + `CommitmentEnded`, SYN-3).
 * Payloads are deliberately explicit — event shapes are semi-permanent once
 * hashed into the chain; changes bump `v` via contracts-first PR (FND D4).
 */

const datetime = z.string().datetime();

// --- commitment lifecycle (emitted by the trio) ---------------------------
export const CommitmentCreated = eventBody(
  'CommitmentCreated',
  z.object({ commitment: Commitment }),
);

export const CommitmentEnded = eventBody(
  'CommitmentEnded',
  z.object({
    commitment_id: Id('com'),
    merchant_id: Id('mer'),
    ended_at: datetime,
    reason: z.string().optional(),
  }),
);

// --- read path (emitted by Core) -------------------------------------------
export const OfferPublished = eventBody(
  'OfferPublished',
  z.object({
    offer_id: Id('off'),
    merchant_id: Id('mer'),
    commitment_id: Id('com').nullable(),
    published_at: datetime,
  }),
);

export const AgentRegistered = eventBody(
  'AgentRegistered',
  z.object({ agent_id: Id('agt'), name: z.string(), registered_at: datetime }),
);

export const QuoteIssued = eventBody(
  'QuoteIssued',
  z.object({
    quote_id: Id('qte'),
    offer_id: Id('off'),
    commitment_id: Id('com'),
    agent_id: Id('agt'),
    consumer_ref: Id('usr').nullable(),
    tier: IdentityTier,
    segment: z.string(),
    price: z.object({ list: Money, final: Money, mechanics_applied: z.array(z.string()) }),
    token_jti: Id('atk').nullable(), // null = unpayable (anonymous) quote
    expires_at: datetime,
  }),
);

export const TokenMinted = eventBody(
  'TokenMinted',
  z.object({ claims: AttributionTokenClaims }), // the claims, never the token string
);

// --- conversion pipeline ----------------------------------------------------
// ConversionClaimed is emitted by the adapter intake, never the trio (SYN-6).
export const ConversionClaimed = eventBody(
  'ConversionClaimed',
  z.object({
    claim_id: Id('clm'),
    merchant_id: Id('mer'),
    jti: Id('atk'),
    qid: Id('qte'),
    cid: Id('com'),
    order_ref_hash: z.string(),
    gross_value: Money,
    ts: datetime,
  }),
);

export const ConversionVerified = eventBody(
  'ConversionVerified',
  z.object({
    claim_id: Id('clm'),
    merchant_id: Id('mer'),
    jti: Id('atk'),
    qid: Id('qte'),
    cid: Id('com'),
    gross_value: Money,
    verified_at: datetime,
  }),
);

export const ConversionRejected = eventBody(
  'ConversionRejected',
  z.object({
    claim_id: Id('clm'),
    merchant_id: Id('mer'),
    jti: Id('atk').nullable(), // null when the token itself was unparseable
    reason_code: RejectionReasonCode,
    rejected_at: datetime,
  }),
);

export const ConversionReversed = eventBody(
  'ConversionReversed',
  z.object({
    claim_id: Id('clm'),
    merchant_id: Id('mer'),
    reversed_at: datetime,
    reason: z.string().optional(),
  }),
);

// --- settlement (emitted by the trio) ---------------------------------------
export const LedgerEntryPosted = eventBody(
  'LedgerEntryPosted',
  z
    .object({
      entry_set_id: z.string(),
      claim_id: Id('clm').nullable(),
      lines: z
        .array(
          z.object({
            account: z.string(),
            side: z.enum(['dr', 'cr']),
            amount: Money,
          }),
        )
        .min(2),
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
    }),
);

export const SettlementNetted = eventBody(
  'SettlementNetted',
  z.object({
    netting_run_id: z.string(),
    period: z.string(),
    positions: z.array(
      z.object({
        party: z.string(),
        direction: z.enum(['payable', 'receivable']),
        amount: Money,
      }),
    ),
  }),
);

// --- consent & identity (emitted by the wallet backend) --------------------
export const MandateGranted = eventBody('MandateGranted', z.object({ mandate: Mandate }));

export const MandateRevoked = eventBody(
  'MandateRevoked',
  z.object({ mandate_id: Id('mnd'), consumer_ref: Id('usr'), revoked_at: datetime }),
);

export const AccountLinked = eventBody('AccountLinked', z.object({ link: IdentityLink }));

export const AccountUnlinked = eventBody(
  'AccountUnlinked',
  z.object({
    link_id: Id('lnk'),
    consumer_ref: Id('usr'),
    merchant_id: Id('mer'),
    revoked_by: z.enum(['wallet', 'brand']),
    unlinked_at: datetime,
  }),
);

export const NotificationSent = eventBody(
  'NotificationSent',
  z.object({
    notification_id: z.string(),
    consumer_ref: Id('usr'),
    quote_id: Id('qte'),
    sent_at: datetime,
  }),
);

export const ApprovalGranted = eventBody('ApprovalGranted', z.object({ approval: Approval }));

export const ApprovalDeclined = eventBody(
  'ApprovalDeclined',
  z.object({ quote_id: Id('qte'), mandate_id: Id('mnd'), declined_at: datetime }),
);

// --- valet errand (mirrored from QUOTED onward, §3; fenced per SYN-21) -----
export const ErrandStateChanged = eventBody(
  'ErrandStateChanged',
  z.object({
    errand_id: Id('ern'),
    agent_id: Id('agt'),
    // Plain strings until VAL-1 lands the ErrandState enum (contracts-first tighten).
    from: z.string(),
    to: z.string(),
    at: datetime,
    quote_id: Id('qte').nullable(),
    claim_id: Id('clm').nullable(),
  }),
);
