import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { Approval, approvalIsQuoteBound } from './approval.js';
import { ConversionClaim } from './claim.js';
import { Commitment } from './commitment.js';
import { AgentCtx, ConsumerCtx } from './ctx.js';
import {
  AGENT_CTX_FIXTURE,
  APPROVAL_FIXTURE,
  CLAIM_FIXTURE,
  COMMITMENT_FIXTURE,
  CONSUMER_CTX_FIXTURE,
  IDENTITY_LINK_FIXTURE,
  MANDATE_FIXTURE,
  OFFER_FIXTURE,
  ORDER_CONFIRMED_FIXTURE,
  QUOTE_FIXTURE,
  TOKEN_CLAIMS_FIXTURE,
} from './fixtures.js';
import { IdentityLink } from './identity-link.js';
import { Mandate } from './mandate.js';
import { Offer } from './offer/offer.js';
import { OrderConfirmed } from './order.js';
import { OfferQuote, quoteExpiryWithinToken } from './quote.js';
import { AttributionTokenClaims } from './token.js';

const GOLDENS: Array<[string, z.ZodTypeAny, unknown]> = [
  ['Offer', Offer, OFFER_FIXTURE],
  ['Commitment', Commitment, COMMITMENT_FIXTURE],
  ['AttributionTokenClaims', AttributionTokenClaims, TOKEN_CLAIMS_FIXTURE],
  ['IdentityLink', IdentityLink, IDENTITY_LINK_FIXTURE],
  ['OfferQuote', OfferQuote, QUOTE_FIXTURE],
  ['Approval', Approval, APPROVAL_FIXTURE],
  ['ConversionClaim', ConversionClaim, CLAIM_FIXTURE],
  ['Mandate', Mandate, MANDATE_FIXTURE],
  ['AgentCtx', AgentCtx, AGENT_CTX_FIXTURE],
  ['ConsumerCtx', ConsumerCtx, CONSUMER_CTX_FIXTURE],
  ['OrderConfirmed', OrderConfirmed, ORDER_CONFIRMED_FIXTURE],
];

describe('§3 object schemas — golden-fixture round-trips (FND-4 accept)', () => {
  it.each(GOLDENS)('%s: parse → serialise → parse is identical', (_name, schema, fixture) => {
    const parsed = schema.parse(fixture);
    const reparsed = schema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
    expect(reparsed).toEqual(fixture);
  });
});

describe('IdentityLink carries no token material (§3 NB, feeds §6.3 accept)', () => {
  it('has no key matching /token|refresh|access|secret/i', () => {
    const keys = Object.keys(IdentityLink.shape);
    for (const key of keys) {
      expect(key).not.toMatch(/token|refresh|access|secret/i);
    }
  });
});

describe('Mandate limit refinements (FND-4 accept)', () => {
  it('rejects per_txn > per_month', () => {
    const bad = {
      ...MANDATE_FIXTURE,
      limits: { ...MANDATE_FIXTURE.limits, per_txn: { amount: 200000, currency: 'GBP_pence' } },
    };
    const result = Mandate.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects pre_authorised_up_to > per_txn', () => {
    const bad = {
      ...MANDATE_FIXTURE,
      pre_authorised_up_to: { amount: 20000, currency: 'GBP_pence' },
    };
    expect(Mandate.safeParse(bad).success).toBe(false);
  });

  it('accepts the ordered case (pre_auth ≤ per_txn ≤ per_month)', () => {
    expect(Mandate.safeParse(MANDATE_FIXTURE).success).toBe(true);
  });
});

describe('Commitment bounty refinement', () => {
  it('fixed bounty requires amount; pct_of_order requires pct_bps', () => {
    const noAmount = { ...COMMITMENT_FIXTURE, bounty: { type: 'fixed' as const } };
    expect(Commitment.safeParse(noAmount).success).toBe(false);
    const pct = { ...COMMITMENT_FIXTURE, bounty: { type: 'pct_of_order' as const, pct_bps: 500 } };
    expect(Commitment.safeParse(pct).success).toBe(true);
    const pctMissing = { ...COMMITMENT_FIXTURE, bounty: { type: 'pct_of_order' as const } };
    expect(Commitment.safeParse(pctMissing).success).toBe(false);
  });
});

describe('quote/approval binding semantics (FND-4 accept)', () => {
  it('quote expires_at ≤ token exp holds for the goldens and fails when violated', () => {
    expect(quoteExpiryWithinToken(QUOTE_FIXTURE, TOKEN_CLAIMS_FIXTURE)).toBe(true);
    expect(
      quoteExpiryWithinToken({ expires_at: '2026-07-04T11:00:00Z' }, TOKEN_CLAIMS_FIXTURE),
    ).toBe(false);
  });

  it('approvalIsQuoteBound: same quote id AND exp = quote.expires_at', () => {
    expect(approvalIsQuoteBound(APPROVAL_FIXTURE, QUOTE_FIXTURE)).toBe(true);
    expect(
      approvalIsQuoteBound({ ...APPROVAL_FIXTURE, exp: '2026-07-04T10:06:00Z' }, QUOTE_FIXTURE),
    ).toBe(false);
    expect(
      approvalIsQuoteBound(
        { ...APPROVAL_FIXTURE, quote_id: 'qte_01J0000000000000000000000K' },
        QUOTE_FIXTURE,
      ),
    ).toBe(false);
  });
});
