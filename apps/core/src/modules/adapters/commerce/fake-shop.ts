import { FakeShopOrderWebhook, type CommerceAdapter, type OrderConfirmed } from '@merited/contracts';
import { normaliseOrder } from '../grade-b/normalise.js';

/**
 * FakeShop as a `CommerceAdapter` (PH3-5): the MER-4 normalisation behind
 * the port interface, so the SAME contract suite runs against FakeShop and
 * Shopify (§2.2 — the fake is the interface's counterpart, and it must not
 * drift from what the real implementation honours).
 */
export class FakeShopCommerceAdapter implements CommerceAdapter {
  normaliseOrderEvent(raw: unknown): OrderConfirmed {
    return normaliseOrder(FakeShopOrderWebhook.parse(raw));
  }
}
