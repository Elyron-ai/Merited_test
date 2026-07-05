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
/** The UCP mapping IS the real adapter (PH3-3) — one source of truth; the
 * conformance suite runs against it directly. */
export { UcpAdapter as UcpStubAdapter } from '../ucp/adapter.js';

/**
 * Contract-stub protocol adapters (PH3-2, §2.2 "fakes are contract stubs
 * only"): the EXACT mapping-table semantics with no transport. PH3-3/PH3-4
 * replace these with the real UCP/ACP integrations behind the SAME
 * `ProtocolAdapter` port and the SAME conformance suite — the stubs are the
 * behavioural contract those adapters must not drift from.
 */

const hashRef = (ref: string): string => createHash('sha256').update(ref).digest('hex');

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
