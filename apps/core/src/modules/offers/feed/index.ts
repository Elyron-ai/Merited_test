import {
  JsonLdOfferFeed,
  type AgentCtx,
  type ConsumerCtx,
  type OfferQuote,
} from '@merited/contracts';
import type { ReadOffers, ReadOffersQuery } from '../read-offers.js';
import type { OffersRepository } from '../repository.js';

/**
 * B11 JSON-LD offer feed (PH3-1). BOTH variants ride the canonical
 * `readOffers()` path (P2 — the feed is a RENDERING, never a bypass):
 * a registered agent's fetch mints quote-bound tokens exactly like any
 * read and carries them in `merited:*` extension fields; an anonymous
 * fetch flows through the same pipeline with `agent_id: null`, where the
 * quote stage mints NOTHING — the entries are visible but not payable,
 * and the register-to-earn hint is the adoption hook (arch §2.3).
 */

/** Integer pence → schema.org decimal string. Integer maths only. */
const decimalPrice = (pence: number): string =>
  `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;

export interface OfferFeedDeps {
  readOffers: ReadOffers;
  repository: OffersRepository;
}

export class OfferFeed {
  constructor(private readonly deps: OfferFeedDeps) {}

  async render(input: {
    agent: AgentCtx;
    consumer?: ConsumerCtx;
    query: ReadOffersQuery;
  }): Promise<JsonLdOfferFeed> {
    const response = await this.deps.readOffers.read(input);
    const anonymous = input.agent.agent_id === null;

    const items = await Promise.all(
      response.quotes.map(async (quote: OfferQuote, index: number) => {
        const record = await this.deps.repository.get(quote.offer_id);
        const offer = record!.offer;
        return {
          '@type': 'ListItem' as const,
          position: index + 1,
          item: {
            '@type': 'Offer' as const,
            identifier: offer.offer_id,
            name: offer.title,
            description: offer.description,
            price: decimalPrice(quote.price.final.amount),
            priceCurrency: 'GBP' as const,
            availabilityStarts: offer.valid_from,
            availabilityEnds: offer.valid_until,
            seller: { '@type': 'Organization' as const, identifier: offer.merchant_id },
            // token material ONLY on the registered variant — the anonymous
            // pipeline minted nothing, so there is nothing to leak
            ...(quote.token !== null
              ? {
                  'merited:quote_id': quote.quote_id,
                  'merited:token': quote.token,
                  'merited:expires_at': quote.expires_at,
                }
              : {}),
          },
        };
      }),
    );

    return JsonLdOfferFeed.parse({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: items,
      ...(anonymous && response.hint
        ? { 'merited:register_to_earn': { register_url: response.hint.register_url } }
        : {}),
    });
  }
}
