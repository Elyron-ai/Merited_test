import { z } from 'zod';

/**
 * Shopify wire conventions (PH3-5, §2.2 Shopify row / §5.8). The token
 * rides a CART ATTRIBUTE named `merited_token`, which Shopify echoes on
 * the order as a note attribute — see docs/spec/protocol-token-transport.md.
 * Deliveries are authenticated with Shopify's NATIVE scheme: base64
 * HMAC-SHA256 over the raw body in `x-shopify-hmac-sha256` (no timestamp
 * header exists in that scheme; replay containment is the webhook id's
 * idempotency plus single-use tokens). Verification is on in EVERY
 * environment including dev (§8).
 */
export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256';
export const SHOPIFY_SHOP_DOMAIN_HEADER = 'x-shopify-shop-domain';
export const SHOPIFY_TOPIC_HEADER = 'x-shopify-topic';
/** Shopify's per-delivery id — the natural Idempotency-Key. */
export const SHOPIFY_WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';
/** The ONE designated cart/note attribute the token rides (mapping rule 1). */
export const SHOPIFY_TOKEN_ATTRIBUTE = 'merited_token';

/**
 * The minimum `orders/paid` surface we consume — a contract stub (§2.2)
 * versioned with the mapping doc; real-spec drift lands here first. Shopify
 * money is DECIMAL STRINGS ("84.50") — converted to integer pence at the
 * normalisation boundary via string maths (`poundsToPence`), never floats.
 */
export const ShopifyOrdersPaid = z.object({
  id: z.number().int().positive(),
  order_number: z.number().int().positive(),
  total_price: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal('GBP'),
  /** ISO 8601, possibly with a UTC offset — normalised at the boundary. */
  processed_at: z.string().min(1),
  note_attributes: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  line_items: z
    .array(z.object({ sku: z.string(), quantity: z.number().int().positive(), price: z.string() }))
    .min(1),
});
export type ShopifyOrdersPaid = z.infer<typeof ShopifyOrdersPaid>;

/** What the normaliser consumes: the delivery's shop-domain header + body
 * (Shopify does not put the shop domain in the payload). */
export const ShopifyOrderEvent = z.object({
  shop_domain: z.string().min(1),
  order: ShopifyOrdersPaid,
});
export type ShopifyOrderEvent = z.infer<typeof ShopifyOrderEvent>;
