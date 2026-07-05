import { createHash } from 'node:crypto';
import {
  ACP_EXPIRES_KEY,
  ACP_QUOTE_KEY,
  ACP_TOKEN_KEY,
  AcpItem,
  AcpOrderWebhook,
  pence,
  type Offer,
  type OfferQuote,
  type OrderConfirmed,
  type ProtocolAdapter,
} from '@merited/contracts';

/**
 * The ACP `ProtocolAdapter` (PH3-4, arch §3.2: interoperate without letting
 * the protocol own attribution). Pure mapping, both directions, exactly per
 * docs/spec/protocol-token-transport.md: ACP carries vendor data in a flat
 * string-map `metadata`, and the token rides ONLY `metadata["merited:token"]`;
 * token-shaped strings under any other key are other vendors' business. The
 * claim path lives in routes.ts, feeding the SAME B12 processor as UCP and
 * Grade-B — no protocol ever gets its own write path.
 */
export class AcpAdapter implements ProtocolAdapter<AcpItem, AcpOrderWebhook> {
  offerOut(input: { quote: OfferQuote; offer: Offer }): AcpItem {
    return AcpItem.parse({
      object: 'acp.item',
      id: input.offer.offer_id,
      name: input.offer.title,
      description: input.offer.description,
      amount_minor: input.quote.price.final.amount,
      currency: 'gbp',
      merchant: input.offer.merchant_id,
      metadata:
        input.quote.token === null
          ? {}
          : {
              [ACP_TOKEN_KEY]: input.quote.token,
              [ACP_QUOTE_KEY]: input.quote.quote_id,
              [ACP_EXPIRES_KEY]: input.quote.expires_at,
            },
    });
  }

  orderIn(callback: AcpOrderWebhook): OrderConfirmed {
    const parsed = AcpOrderWebhook.parse(callback);
    const token = parsed.metadata[ACP_TOKEN_KEY]; // the ONE designated key
    return {
      order_ref_hash: createHash('sha256').update(parsed.order_ref).digest('hex'),
      gross_value: pence(parsed.amount_minor),
      ...(token ? { token } : {}),
      ts: parsed.created_at,
    };
  }
}
