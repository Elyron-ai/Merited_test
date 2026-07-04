import type { MeritedId } from '@merited/contracts';

export interface CheckoutRequest {
  sku: string;
  attribution_token: string | null;
  /** The errand IS the idempotency scope: `Idempotency-Key: ern_…` (§8)
   * means a resumed errand replays the same confirmation, never a second
   * order. */
  errand_id: MeritedId<'ern'>;
}

export interface CheckoutConfirmation {
  order_number: number;
  total_pence: number;
  webhook: 'delivered' | 'dropped' | 'failed';
}

/** The merchant-side execution rail (VAL-5). FakeShop in Phase 0; Shopify
 * and UCP/ACP land as further implementations in Phase 3 — the driver only
 * ever sees this interface. */
export interface CheckoutRail {
  checkout(request: CheckoutRequest): Promise<CheckoutConfirmation>;
}

export class CheckoutFailedError extends Error {
  constructor(status: number, detail: string) {
    super(`checkout failed (${status}): ${detail}`);
    this.name = 'CheckoutFailedError';
  }
}

export class FakeShopRail implements CheckoutRail {
  constructor(private readonly shopBaseUrl: string) {}

  async checkout(request: CheckoutRequest): Promise<CheckoutConfirmation> {
    const response = await fetch(`${this.shopBaseUrl.replace(/\/$/, '')}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': request.errand_id,
      },
      body: JSON.stringify({ sku: request.sku, attribution_token: request.attribution_token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) {
      throw new CheckoutFailedError(response.status, (await response.text()).slice(0, 200));
    }
    return (await response.json()) as CheckoutConfirmation;
  }
}
