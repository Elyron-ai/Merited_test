import { createHash } from 'node:crypto';
import { OrderConfirmed, type FakeShopOrderWebhook } from '@merited/contracts';

/**
 * Native payload → `OrderConfirmed` (MER-4, §5.8). THE data-minimisation
 * boundary (arch §2.4): basket contents are dropped here — only the hashed
 * order reference and integer-pence money numbers survive. The raw order
 * ref is hashed with the shop domain so numbers from different shops never
 * collide.
 */
export const normaliseOrder = (payload: FakeShopOrderWebhook): OrderConfirmed => {
  const { order } = payload;
  if (!Number.isInteger(order.total.amount_minor) || order.total.amount_minor < 0) {
    throw new Error('order total must be non-negative integer pence');
  }
  return OrderConfirmed.parse({
    order_ref_hash: createHash('sha256')
      .update(`${payload.shop_domain}:${order.number}`, 'utf8')
      .digest('hex'),
    gross_value: { amount: order.total.amount_minor, currency: 'GBP_pence' },
    ...(order.attribution.merited_token ? { token: order.attribution.merited_token } : {}),
    ts: order.placed_at,
  });
};
