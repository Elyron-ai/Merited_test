import { createHash } from 'node:crypto';
import {
  ACP_EXPIRES_KEY,
  ACP_QUOTE_KEY,
  ACP_TOKEN_KEY,
  AcpItem,
  AcpOrderWebhook,
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
 * Contract-stub protocol adapters (PH3-2, §2.2 "fakes are contract stubs
 * only"): the EXACT mapping-table semantics with no transport. PH3-3/PH3-4
 * replace these with the real UCP/ACP integrations behind the SAME
 * `ProtocolAdapter` port and the SAME conformance suite — the stubs are the
 * behavioural contract those adapters must not drift from.
 */

const hashRef = (ref: string): string => createHash('sha256').update(ref).digest('hex');

export class UcpStubAdapter implements ProtocolAdapter<UcpOffer, UcpCheckoutCompleted> {
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
    // the DESIGNATED field only (rule 1); anything else in extensions is
    // someone else's namespace and none of our business
    const extension = UcpAttributionExtension.safeParse(
      parsed.order.extensions[UCP_EXTENSION_KEY],
    );
    return {
      order_ref_hash: hashRef(parsed.order.order_ref),
      gross_value: pence(parsed.order.total.amount_minor),
      ...(extension.success ? { token: extension.data.token } : {}),
      ts: parsed.order.completed_at,
    };
  }
}

export class AcpStubAdapter implements ProtocolAdapter<AcpItem, AcpOrderWebhook> {
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
      order_ref_hash: hashRef(parsed.order_ref),
      gross_value: pence(parsed.amount_minor),
      ...(token ? { token } : {}),
      ts: parsed.created_at,
    };
  }
}
