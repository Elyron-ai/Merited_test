import { z } from 'zod';

/**
 * Grade-B inbound webhook wire conventions (MER-1, §5.8/§8). Signature
 * verification is on in EVERY environment including dev/CI (§8).
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-merited-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-merited-timestamp';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** MER-3: deliveries with a timestamp skewed beyond this are rejected 401. */
export const WEBHOOK_TIMESTAMP_MAX_SKEW_S = 300;

/**
 * The byte layout both sides HMAC-SHA256 over (hex digest in the signature
 * header): `${unix-seconds-timestamp}.${raw-request-body}`. The timestamp
 * binding defeats replay-with-old-signature; the raw body (never a re-parse)
 * is what MER-3 verifies. Contracts pins the LAYOUT only — the HMAC itself
 * lives with each side's crypto (this package stays dependency-free).
 */
export const webhookSignaturePayload = (timestampS: number, rawBody: string): string =>
  `${timestampS}.${rawBody}`;

/**
 * FakeShop's NATIVE order payload — deliberately shaped differently from
 * `OrderConfirmed` (nested minor-unit money, raw order number, basket
 * lines) so MER-4's normaliser is genuinely exercised: the basket is
 * dropped and the order ref hashed at that boundary (arch §2.4 data
 * minimisation — only hash + money numbers survive).
 */
export const FakeShopOrderWebhook = z.object({
  event: z.literal('order.confirmed'),
  shop_domain: z.string().min(1),
  order: z.object({
    number: z.number().int().positive(),
    placed_at: z.string().datetime(),
    total: z.object({
      amount_minor: z.number().int().nonnegative(),
      currency_code: z.literal('GBP'),
    }),
    attribution: z.object({
      merited_token: z.string().nullable(),
    }),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1),
          qty: z.number().int().positive(),
          unit_price_minor: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
});
export type FakeShopOrderWebhook = z.infer<typeof FakeShopOrderWebhook>;
