import * as defs from './definitions.js';

export * from './definitions.js';
export { eventBody } from './envelope.js';
export type { EventBody } from './envelope.js';

/**
 * The complete event catalogue — exactly 21 (§3 + SYN-3 + SYN-41). Body schemas live
 * here in contracts (single source of types, §1); packages/events binds the
 * frozen name → schema registry over this map (FND D9).
 */
export const MERITED_EVENT_BODIES = {
  CommitmentCreated: defs.CommitmentCreated,
  CommitmentEnded: defs.CommitmentEnded,
  QuoteIssued: defs.QuoteIssued,
  TokenMinted: defs.TokenMinted,
  ApprovalGranted: defs.ApprovalGranted,
  ApprovalDeclined: defs.ApprovalDeclined,
  ConversionClaimed: defs.ConversionClaimed,
  ConversionVerified: defs.ConversionVerified,
  ConversionRejected: defs.ConversionRejected,
  ConversionReversed: defs.ConversionReversed,
  LedgerEntryPosted: defs.LedgerEntryPosted,
  SettlementNetted: defs.SettlementNetted,
  MandateGranted: defs.MandateGranted,
  MandateRevoked: defs.MandateRevoked,
  AccountLinked: defs.AccountLinked,
  AccountUnlinked: defs.AccountUnlinked,
  NotificationSent: defs.NotificationSent,
  OfferPublished: defs.OfferPublished,
  OfferSuppressed: defs.OfferSuppressed,
  AgentRegistered: defs.AgentRegistered,
  ErrandStateChanged: defs.ErrandStateChanged,
} as const;

export type MeritedEventName = keyof typeof MERITED_EVENT_BODIES;
export const MERITED_EVENT_NAMES = Object.keys(MERITED_EVENT_BODIES) as MeritedEventName[];
