import {
  APPROVAL_FIXTURE,
  CLAIM_FIXTURE,
  COMMITMENT_FIXTURE,
  FIXTURE_IDS,
  IDENTITY_LINK_FIXTURE,
  MANDATE_FIXTURE,
  QUOTE_FIXTURE,
  TOKEN_CLAIMS_FIXTURE,
} from '../fixtures.js';
import type { MeritedEventName } from './index.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP_pence' as const });
const ids = FIXTURE_IDS;
const at = '2026-07-04T10:03:00Z';

/** One golden fixture per event body (FND-7 accept). */
export const EVENT_FIXTURES: Record<MeritedEventName, unknown> = {
  CommitmentCreated: {
    type: 'CommitmentCreated',
    v: 1,
    data: { commitment: COMMITMENT_FIXTURE },
  },
  CommitmentEnded: {
    type: 'CommitmentEnded',
    v: 1,
    data: { commitment_id: ids.commitment, merchant_id: ids.merchant, ended_at: at },
  },
  QuoteIssued: {
    type: 'QuoteIssued',
    v: 1,
    data: {
      quote_id: ids.quote,
      offer_id: ids.offer,
      commitment_id: ids.commitment,
      agent_id: ids.agent,
      consumer_ref: null,
      tier: 'T3',
      segment: 't3-acquisition',
      price: QUOTE_FIXTURE.price,
      token_jti: ids.token,
      expires_at: QUOTE_FIXTURE.expires_at,
    },
  },
  TokenMinted: { type: 'TokenMinted', v: 1, data: { claims: TOKEN_CLAIMS_FIXTURE } },
  ApprovalGranted: { type: 'ApprovalGranted', v: 1, data: { approval: APPROVAL_FIXTURE } },
  ApprovalDeclined: {
    type: 'ApprovalDeclined',
    v: 1,
    data: { quote_id: ids.quote, mandate_id: ids.mandate, declined_at: at },
  },
  ConversionClaimed: {
    type: 'ConversionClaimed',
    v: 1,
    data: {
      claim_id: ids.claim,
      merchant_id: ids.merchant,
      jti: ids.token,
      qid: ids.quote,
      cid: ids.commitment,
      order_ref_hash: CLAIM_FIXTURE.order.order_ref_hash,
      gross_value: gbp(8450),
      ts: at,
    },
  },
  ConversionVerified: {
    type: 'ConversionVerified',
    v: 1,
    data: {
      claim_id: ids.claim,
      merchant_id: ids.merchant,
      jti: ids.token,
      qid: ids.quote,
      cid: ids.commitment,
      gross_value: gbp(8450),
      verified_at: at,
    },
  },
  ConversionRejected: {
    type: 'ConversionRejected',
    v: 1,
    data: {
      claim_id: ids.claim,
      merchant_id: ids.merchant,
      jti: ids.token,
      reason_code: 'TOKEN_REPLAYED',
      rejected_at: at,
    },
  },
  ConversionReversed: {
    type: 'ConversionReversed',
    v: 1,
    data: { claim_id: ids.claim, merchant_id: ids.merchant, reversed_at: at },
  },
  LedgerEntryPosted: {
    type: 'LedgerEntryPosted',
    v: 1,
    data: {
      entry_set_id: 'set_fixture_1',
      claim_id: ids.claim,
      lines: [
        { account: `merchant_payable:${ids.merchant}`, side: 'dr', amount: gbp(1200) },
        { account: `agent_receivable:${ids.agent}`, side: 'cr', amount: gbp(720) },
        { account: 'platform_revenue', side: 'cr', amount: gbp(240) },
        { account: `reserve:${ids.merchant}`, side: 'cr', amount: gbp(240) },
      ],
    },
  },
  SettlementNetted: {
    type: 'SettlementNetted',
    v: 1,
    data: {
      netting_run_id: 'net_fixture_1',
      period: '2026-W27',
      positions: [
        { party: ids.merchant, direction: 'payable', amount: gbp(1200) },
        { party: ids.agent, direction: 'receivable', amount: gbp(720) },
      ],
    },
  },
  MandateGranted: { type: 'MandateGranted', v: 1, data: { mandate: MANDATE_FIXTURE } },
  MandateRevoked: {
    type: 'MandateRevoked',
    v: 1,
    data: { mandate_id: ids.mandate, consumer_ref: ids.consumer, revoked_at: at },
  },
  AccountLinked: { type: 'AccountLinked', v: 1, data: { link: IDENTITY_LINK_FIXTURE } },
  AccountUnlinked: {
    type: 'AccountUnlinked',
    v: 1,
    data: {
      link_id: ids.link,
      consumer_ref: ids.consumer,
      merchant_id: ids.merchant,
      revoked_by: 'wallet',
      unlinked_at: at,
    },
  },
  NotificationSent: {
    type: 'NotificationSent',
    v: 1,
    data: { notification_id: 'ntf_fixture_1', consumer_ref: ids.consumer, quote_id: ids.quote, sent_at: at },
  },
  OfferPublished: {
    type: 'OfferPublished',
    v: 1,
    data: { offer_id: ids.offer, merchant_id: ids.merchant, commitment_id: ids.commitment, published_at: at },
  },
  AgentRegistered: {
    type: 'AgentRegistered',
    v: 1,
    data: { agent_id: ids.agent, name: 'Valet v0', registered_at: at },
  },
  ErrandStateChanged: {
    type: 'ErrandStateChanged',
    v: 1,
    data: {
      errand_id: 'ern_01J0000000000000000000000N',
      agent_id: ids.agent,
      from: 'SEARCHING',
      to: 'QUOTED',
      at,
      quote_id: ids.quote,
      claim_id: null,
    },
  },
};
