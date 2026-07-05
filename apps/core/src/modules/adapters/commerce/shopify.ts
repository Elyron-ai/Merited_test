import { createHash } from 'node:crypto';
import {
  OrderConfirmed,
  SHOPIFY_TOKEN_ATTRIBUTE,
  ShopifyOrderEvent,
  poundsToPence,
  type CommerceAdapter,
} from '@merited/contracts';

/**
 * Shopify `CommerceAdapter` (PH3-5, §5.8): `orders/paid` → `OrderConfirmed`.
 * THE data-minimisation boundary for the Shopify path (arch §2.4): line
 * items are dropped here — only the hashed order reference and integer-pence
 * money numbers survive. Shopify's decimal-string totals convert via string
 * maths (`poundsToPence`) — a float never touches a monetary value. The
 * token is read from the ONE designated note attribute (`merited_token`,
 * the cart attribute Shopify echoes onto the order); token-shaped strings
 * anywhere else are ignored.
 */
export class ShopifyCommerceAdapter implements CommerceAdapter {
  normaliseOrderEvent(raw: unknown): OrderConfirmed {
    const event = ShopifyOrderEvent.parse(raw);
    const token = event.order.note_attributes.find(
      (attribute) => attribute.name === SHOPIFY_TOKEN_ATTRIBUTE,
    )?.value;
    const processedAt = new Date(event.order.processed_at);
    if (Number.isNaN(processedAt.getTime())) {
      throw new Error('orders/paid processed_at is not a parseable timestamp');
    }
    return OrderConfirmed.parse({
      order_ref_hash: createHash('sha256')
        .update(`${event.shop_domain}:${event.order.id}`, 'utf8')
        .digest('hex'),
      gross_value: { amount: poundsToPence(event.order.total_price), currency: 'GBP_pence' },
      ...(token ? { token } : {}),
      ts: processedAt.toISOString(),
    });
  }
}
