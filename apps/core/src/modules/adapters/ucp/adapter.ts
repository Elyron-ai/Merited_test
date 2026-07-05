import { createHash } from 'node:crypto';
import {
  UCP_EXTENSION_KEY,
  UcpAttributionExtension,
  UcpCheckoutCompleted,
  UcpOffer,
  pence,
  ucpMoney,
  type Offer,
  type OfferQuote,
  type OrderConfirmed,
  type ProtocolAdapter,
} from '@merited/contracts';

/**
 * The UCP `ProtocolAdapter` (PH3-3, arch §3.2: interoperate without letting
 * the protocol own attribution). Pure mapping, both directions, exactly per
 * docs/spec/protocol-token-transport.md: the token rides ONLY the
 * `com.merited.attribution` extension envelope; anything token-shaped
 * anywhere else is ignored; the token is opaque — byte-identical or
 * nothing. The claim path (checkout-callback → signed ConversionClaim)
 * lives in routes.ts, which feeds the SAME B12 processor every other
 * integration uses — the protocol never gets its own write path.
 */
export class UcpAdapter implements ProtocolAdapter<UcpOffer, UcpCheckoutCompleted> {
  offerOut(input: { quote: OfferQuote; offer: Offer }): UcpOffer {
    return UcpOffer.parse({
      type: 'ucp.offer',
      id: input.offer.offer_id,
      title: input.offer.title,
      description: input.offer.description,
      price: ucpMoney(input.quote.price.final),
      seller_id: input.offer.merchant_id,
      valid_until: input.quote.expires_at,
      extensions:
        input.quote.token === null
          ? {}
          : {
              [UCP_EXTENSION_KEY]: UcpAttributionExtension.parse({
                token: input.quote.token,
                quote_id: input.quote.quote_id,
                expires_at: input.quote.expires_at,
              }),
            },
    });
  }

  orderIn(callback: UcpCheckoutCompleted): OrderConfirmed {
    const parsed = UcpCheckoutCompleted.parse(callback);
    // the DESIGNATED field only (mapping rule 1); other namespaces are
    // other vendors' business
    const extension = UcpAttributionExtension.safeParse(
      parsed.order.extensions[UCP_EXTENSION_KEY],
    );
    return {
      order_ref_hash: createHash('sha256').update(parsed.order.order_ref).digest('hex'),
      gross_value: pence(parsed.order.total.amount_minor),
      ...(extension.success ? { token: extension.data.token } : {}),
      ts: parsed.order.completed_at,
    };
  }
}
