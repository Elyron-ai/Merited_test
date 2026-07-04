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

/**
 * Product resolution for VAL-6's driver: browse the shop's PUBLIC catalogue
 * (`GET /skus` — a customer-visible surface, P5) and pick the product whose
 * name best matches the brief. Null when nothing overlaps.
 */
export const shopCatalogueSkuResolver = (shopBaseUrl: string) => {
  const base = shopBaseUrl.replace(/\/$/, '');
  return async (brief: { text: string }): Promise<string | null> => {
    const response = await fetch(`${base}/skus`, { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) return null;
    const { skus } = (await response.json()) as { skus: Array<{ sku: string; name: string }> };
    const words = brief.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    let best: string | null = null;
    let bestScore = 0;
    for (const entry of skus) {
      const name = entry.name.toLowerCase();
      const score = words.filter((word) => name.includes(word)).length;
      if (score > bestScore) {
        best = entry.sku;
        bestScore = score;
      }
    }
    return best;
  };
};
