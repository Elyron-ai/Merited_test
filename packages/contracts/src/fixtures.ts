import type { Approval } from './approval.js';
import type { ConversionClaim } from './claim.js';
import type { Commitment } from './commitment.js';
import type { AgentCtx, ConsumerCtx } from './ctx.js';
import type { IdentityLink } from './identity-link.js';
import type { Mandate } from './mandate.js';
import type { Offer } from './offer/offer.js';
import type { OrderConfirmed } from './order.js';
import type { OfferQuote } from './quote.js';
import type { AttributionTokenClaims } from './token.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

// Fixed, hand-written ULIDs (VAL D6 discipline applied from day one): byte-stable
// goldens for round-trip tests, reusable by seed/demo tooling.
export const FIXTURE_IDS = {
  merchant: 'mer_01J0000000000000000000000A',
  offer: 'off_01J0000000000000000000000B',
  commitment: 'com_01J0000000000000000000000C',
  agent: 'agt_01J0000000000000000000000D',
  token: 'atk_01J0000000000000000000000E',
  claim: 'clm_01J0000000000000000000000F',
  mandate: 'mnd_01J0000000000000000000000G',
  consumer: 'usr_01J0000000000000000000000H',
  quote: 'qte_01J0000000000000000000000J',
  approval: 'apr_01J0000000000000000000000K',
  link: 'lnk_01J0000000000000000000000M',
} as const;

const ids = FIXTURE_IDS;

export const OFFER_FIXTURE: Offer = {
  offer_id: ids.offer,
  merchant_id: ids.merchant,
  title: 'Aurora spa day',
  description: 'A full spa day at Aurora Experiences, member pricing available.',
  mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: gbp(8450) },
  sku_scope: ['sku_spa_day'],
  identity_tiers: ['T1', 'T2', 'T3'],
  stacking_group: null,
  status: 'live',
  valid_from: '2026-07-01T00:00:00Z',
  valid_until: '2026-12-31T23:59:59Z',
};

export const COMMITMENT_FIXTURE: Commitment = {
  commitment_id: ids.commitment,
  merchant_id: ids.merchant,
  offer_ref: ids.offer,
  bounty: { type: 'fixed', amount: gbp(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  },
  merchant_sig: 'fake-ed25519:merchant-sig-fixture',
  platform_sig: 'fake-ed25519:platform-sig-fixture',
};

export const TOKEN_CLAIMS_FIXTURE: AttributionTokenClaims = {
  jti: ids.token,
  cid: ids.commitment,
  qid: ids.quote,
  aid: ids.agent,
  tier: 'T3',
  sid: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  apr: null,
  iat: 1783159200, // 2026-07-04T10:00:00Z
  exp: 1783159800, // 2026-07-04T10:10:00Z (iat + 600s)
};

export const QUOTE_FIXTURE: OfferQuote = {
  quote_id: ids.quote,
  offer_id: ids.offer,
  commitment_id: ids.commitment,
  agent_id: ids.agent,
  consumer_ref: null,
  tier: 'T3',
  segment: 't3-acquisition',
  price: { list: gbp(9900), final: gbp(8450), mechanics_applied: ['member_price'] },
  token: 'v4.public.fake.fixture-token',
  expires_at: '2026-07-04T10:05:00Z', // ≤ token exp (1782989400 = 10:10:00Z)
};

export const APPROVAL_FIXTURE: Approval = {
  approval_id: ids.approval,
  mandate_id: ids.mandate,
  quote_id: ids.quote,
  mode: 'explicit',
  approved_at: '2026-07-04T10:01:00Z',
  exp: '2026-07-04T10:05:00Z', // = quote.expires_at
  attestation: 'fake-ed25519:approval-attestation-fixture',
};

export const CLAIM_FIXTURE: ConversionClaim = {
  claim_id: ids.claim,
  merchant_id: ids.merchant,
  attribution_token: 'v4.public.fake.fixture-token',
  order: {
    order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    gross_value: gbp(8450),
    ts: '2026-07-04T10:03:00Z',
  },
  merchant_sig: 'fake-ed25519:claim-sig-fixture',
};

export const MANDATE_FIXTURE: Mandate = {
  mandate_id: ids.mandate,
  consumer_ref: ids.consumer,
  agent_id: ids.agent,
  scopes: ['offers:read', 'loyalty:read', 'checkout:execute'],
  limits: { per_txn: gbp(15000), per_month: gbp(150000), categories: ['experiences'] },
  merchants: ['*'],
  data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
  pre_authorised_up_to: gbp(5000),
  status: 'active',
  exp: '2026-12-31T23:59:59Z',
  attestation: 'fake-ed25519:mandate-attestation-fixture',
};

export const IDENTITY_LINK_FIXTURE: IdentityLink = {
  link_id: ids.link,
  consumer_ref: ids.consumer,
  merchant_id: ids.merchant,
  programme: 'aurora-club',
  member_ref: 'tok_member_ref_fixture',
  sub_hash: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
  scopes: ['profile', 'balance', 'tier'],
  status: 'active',
  linked_at: '2026-07-01T09:00:00Z',
};

export const AGENT_CTX_FIXTURE: AgentCtx = { agent_id: ids.agent };

export const CONSUMER_CTX_FIXTURE: ConsumerCtx = {
  consumer_ref: ids.consumer,
  sub_hash: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
};

export const ORDER_CONFIRMED_FIXTURE: OrderConfirmed = {
  order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  gross_value: gbp(8450),
  token: 'v4.public.fake.fixture-token',
  ts: '2026-07-04T10:03:00Z',
};
