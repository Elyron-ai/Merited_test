import { z } from 'zod';

/**
 * B11 JSON-LD offer feed (PH3-1, §5.2/arch §2.3): schema.org/Offer entries
 * in an ItemList. TWO variants from ONE canonical read path (P2 — no
 * bypass): registered agents receive quote-bound token material in the
 * `merited:*` extension properties; anonymous fetchers receive the SAME
 * offers UNTOKENISED — visible but not payable — plus the register-to-earn
 * adoption hint. Prices are decimal STRINGS derived from integer pence
 * (schema.org convention); the pence never become floats.
 */
export const JsonLdOffer = z.object({
  '@type': z.literal('Offer'),
  identifier: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.string().regex(/^\d+\.\d{2}$/),
  priceCurrency: z.literal('GBP'),
  availabilityStarts: z.string().datetime(),
  availabilityEnds: z.string().datetime(),
  seller: z.object({ '@type': z.literal('Organization'), identifier: z.string() }),
  /** Registered variant only: the payable quote riding the entry. */
  'merited:quote_id': z.string().optional(),
  'merited:token': z.string().optional(),
  'merited:expires_at': z.string().datetime().optional(),
});
export type JsonLdOffer = z.infer<typeof JsonLdOffer>;

export const JsonLdOfferFeed = z.object({
  '@context': z.literal('https://schema.org'),
  '@type': z.literal('ItemList'),
  itemListElement: z.array(
    z.object({
      '@type': z.literal('ListItem'),
      position: z.number().int().positive(),
      item: JsonLdOffer,
    }),
  ),
  /** Anonymous variant only (§2.3): visible but not payable is the hook. */
  'merited:register_to_earn': z
    .object({ register_url: z.string() })
    .optional(),
});
export type JsonLdOfferFeed = z.infer<typeof JsonLdOfferFeed>;
