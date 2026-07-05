import { createHmac, timingSafeEqual } from 'node:crypto';

export type ShopifyVerification = { ok: true } | { ok: false; reason: string };

/**
 * Shopify's NATIVE delivery authentication (PH3-5, §8 — verification on in
 * every environment including dev): base64 HMAC-SHA256 over the raw request
 * bytes, compared in constant time against `x-shopify-hmac-sha256`. Checked
 * against every active secret so rotation keeps the overlap window (SYN-39
 * — the same policy as the Merited scheme). Shopify's scheme carries no
 * timestamp; replay containment is the delivery id's idempotency plus
 * single-use tokens at the trio.
 */
export const verifyShopifyHmac = (input: {
  rawBody: string;
  hmacHeader: string | undefined;
  secrets: string[];
}): ShopifyVerification => {
  if (!input.hmacHeader) return { ok: false, reason: 'missing_signature' };
  let given: Buffer;
  try {
    given = Buffer.from(input.hmacHeader, 'base64');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  for (const secret of input.secrets) {
    const digest = createHmac('sha256', secret).update(input.rawBody, 'utf8').digest();
    if (given.length === digest.length && timingSafeEqual(digest, given)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
};
