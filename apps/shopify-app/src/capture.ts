import { SHOPIFY_TOKEN_ATTRIBUTE } from '@merited/contracts';

/**
 * Checkout-side token capture (PH3-5): the agent presents its attribution
 * token and the storefront writes it as THE designated cart attribute —
 * Shopify then echoes cart attributes onto the order as note attributes,
 * which is where the `orders/paid` normalisation reads it back. One
 * designated field, opaque token, byte-identical or nothing (the same
 * mapping rules as the protocol adapters).
 *
 * On a real store this map is the body of `POST /cart/update.js`
 * (`{attributes: {...}}`) or the `attributes` input on a Storefront-API
 * cart mutation — see docs/spec/protocol-token-transport.md.
 */
export const cartAttributesFor = (token: string | null): Record<string, string> =>
  token === null ? {} : { [SHOPIFY_TOKEN_ATTRIBUTE]: token };

/** The webhook subscription the app registers on install (LEAD-3/PH3-6):
 * `orders/paid` pointed at the merchant's core intake. */
export const ordersPaidSubscription = (address: string): {
  topic: 'orders/paid';
  address: string;
  format: 'json';
} => ({ topic: 'orders/paid', address, format: 'json' });
