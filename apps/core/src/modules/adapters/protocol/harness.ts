import { createHash } from 'node:crypto';
import {
  OrderConfirmed,
  newId,
  pence,
  type Offer,
  type OfferQuote,
  type ProtocolAdapter,
} from '@merited/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The shared protocol conformance harness (PH3-2): drives offer-out and
 * checkout-callback-in through ANY `ProtocolAdapter` and proves the
 * mapping-table rules (docs/spec/protocol-token-transport.md):
 *   1. the token rides EXACTLY the designated field — offer-out places it
 *      there and NOWHERE else in the serialised payload;
 *   2. the round-trip is byte-identical (rule 2: the token is opaque);
 *   3. a callback with an EMPTY designated field yields no token — the
 *      claim path never starts (P2: no token, no bounty);
 *   4. token-shaped strings OUTSIDE the designated field are ignored;
 *   5. prices cross as integer minor units (rule 3).
 * PH3-3 (UCP) and PH3-4 (ACP) run THIS suite against their real adapters.
 */

export interface ConformanceCase<TOffer, TCallback> {
  adapter: ProtocolAdapter<TOffer, TCallback>;
  /** Read the token back from the offer payload's DESIGNATED field. */
  tokenFieldOf(offerOut: TOffer): string | undefined;
  /** A recorded checkout callback echoing the given designated-field token. */
  callbackWith(token: string | undefined, orderRefHash: string, grossPence: number): TCallback;
  /** The same callback with the token smuggled OUTSIDE the designated field. */
  callbackWithSmuggledToken(token: string, orderRefHash: string, grossPence: number): TCallback;
  /** Serialise for the placement scan. */
  serialise(payload: TOffer | TCallback): string;
}

const TEST_TOKEN = 'v4.public.conformance-harness-token-material';

export const fixtureQuote = (): { quote: OfferQuote; offer: Offer } => {
  const offer: Offer = {
    offer_id: newId('off'),
    merchant_id: newId('mer'),
    title: 'Full spa day — Aurora Club price',
    description: 'A conformance-harness fixture offer',
    mechanics: { type: 'percentage_off', pct_bps: 1500 },
    sku_scope: ['sku_spa_day'],
    identity_tiers: ['T1', 'T2', 'T3'],
    stacking_group: null,
    status: 'live',
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-12-31T23:59:59Z',
  };
  const quote: OfferQuote = {
    quote_id: newId('qte'),
    offer_id: offer.offer_id,
    commitment_id: newId('com'),
    agent_id: newId('agt'),
    consumer_ref: null,
    tier: 'T1',
    segment: 't1-gold-new',
    price: { list: pence(8450), final: pence(7183), mechanics_applied: ['percentage_off'] },
    token: TEST_TOKEN,
    expires_at: '2026-07-05T12:10:00Z',
  };
  return { quote, offer };
};

export const protocolConformanceSuite = <TOffer, TCallback>(
  name: string,
  makeCase: () => ConformanceCase<TOffer, TCallback>,
): void => {
  describe(`protocol conformance — ${name}`, () => {
    const orderRef = `${name.replace(/[^a-z0-9]+/gi, '-')}-order-0001`;
    // adapters HASH the protocol's order reference before it ever persists
    const expectedHash = createHash('sha256').update(orderRef).digest('hex');

    it('offer-out places the token in the DESIGNATED field and nowhere else', () => {
      const c = makeCase();
      const { quote, offer } = fixtureQuote();
      const out = c.adapter.offerOut({ quote, offer });
      expect(c.tokenFieldOf(out)).toBe(TEST_TOKEN);
      // the ONLY occurrence in the whole payload is the designated field
      const serialised = c.serialise(out);
      expect(serialised.split(TEST_TOKEN).length - 1).toBe(1);
    });

    it('the token survives the round-trip byte-identically (opaque, rule 2)', () => {
      const c = makeCase();
      const callback = c.callbackWith(TEST_TOKEN, orderRef, 8450);
      const order = OrderConfirmed.parse(c.adapter.orderIn(callback));
      expect(order.token).toBe(TEST_TOKEN);
      expect(order.order_ref_hash).toBe(expectedHash);
      expect(order.gross_value).toEqual(pence(8450)); // integer minor units, rule 3
    });

    it('P2: an empty designated field yields NO token — the claim path never starts', () => {
      const c = makeCase();
      const order = OrderConfirmed.parse(c.adapter.orderIn(c.callbackWith(undefined, orderRef, 8450)));
      expect(order.token).toBeUndefined();
    });

    it('a token smuggled OUTSIDE the designated field is IGNORED (rule 1: no scraping)', () => {
      const c = makeCase();
      const callback = c.callbackWithSmuggledToken(TEST_TOKEN, orderRef, 8450);
      expect(c.serialise(callback)).toContain(TEST_TOKEN); // it IS in the payload…
      const order = OrderConfirmed.parse(c.adapter.orderIn(callback));
      expect(order.token).toBeUndefined(); // …and the adapter refuses it
    });
  });
};
