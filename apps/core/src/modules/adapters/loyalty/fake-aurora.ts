import type { LoyaltyLookup } from '@merited/contracts';

/**
 * `LoyaltyLookup` over the FakeAurora loyalty API (PH1-11, §2.2 Eagle Eye
 * row). Speaks the brand's HTTP loyalty contract; a real Eagle Eye AIR
 * wire-up (PH2-10) slots in behind this same interface. Points-credit
 * idempotency lives in the brand backend (per order_ref_hash) — this
 * adapter just forwards.
 */
export interface FakeAuroraLoyaltyOptions {
  baseUrl: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
}

export class FakeAuroraLoyalty implements LoyaltyLookup {
  constructor(private readonly options: FakeAuroraLoyaltyOptions) {}

  private headers(): Record<string, string> {
    return this.options.serviceToken
      ? { 'x-merited-service-token': this.options.serviceToken }
      : {};
  }

  async memberByRef(memberRef: string): Promise<{ tier: string; balance: number } | null> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(
      `${this.options.baseUrl}/loyalty/members/${encodeURIComponent(memberRef)}`,
      { headers: this.headers() },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`loyalty lookup failed: ${response.status}`);
    const body = (await response.json()) as { tier: string; balance: number };
    return { tier: body.tier, balance: body.balance };
  }

  async creditPoints(input: {
    member_ref: string;
    points: number;
    order_ref_hash: string;
  }): Promise<void> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`${this.options.baseUrl}/loyalty/credit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`loyalty credit failed: ${response.status}`);
  }
}
