import { SHOPIFY_TOKEN_ATTRIBUTE } from '@merited/contracts';
import { CheckoutFailedError, type CheckoutConfirmation, type CheckoutRail, type CheckoutRequest } from './checkout-rail.js';

/**
 * The Shopify execution rail (PH3-5, §6.6's Phase-3 rails): Valet checks
 * out on a Shopify storefront, presenting its attribution token as THE
 * designated cart attribute (`merited_token`) — the store echoes it onto
 * the order and `orders/paid` carries it back to core. Against the
 * simulated store in CI; the same wire shape drives the real dev store
 * (launch-readiness A12). The errand is the idempotency scope, as on every
 * rail: a resumed errand replays the same confirmation, never a second
 * order.
 */
export class ShopifyCheckoutRail implements CheckoutRail {
  constructor(private readonly storeBaseUrl: string) {}

  async checkout(request: CheckoutRequest): Promise<CheckoutConfirmation> {
    const base = this.storeBaseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': request.errand_id,
      },
      body: JSON.stringify({
        sku: request.sku,
        attributes:
          request.attribution_token === null
            ? {}
            : { [SHOPIFY_TOKEN_ATTRIBUTE]: request.attribution_token },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      throw new CheckoutFailedError(response.status, (await response.text()).slice(0, 200));
    }
    const confirmation = (await response.json()) as CheckoutConfirmation;
    return {
      order_number: confirmation.order_number,
      total_pence: confirmation.total_pence,
      webhook: confirmation.webhook,
    };
  }
}
