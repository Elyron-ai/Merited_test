import { createHash, createHmac } from 'node:crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  UCP_EXTENSION_KEY,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignaturePayload,
  type UcpCheckoutCompleted,
} from '@merited/contracts';
import { CheckoutFailedError, type CheckoutConfirmation, type CheckoutRail, type CheckoutRequest } from './checkout-rail.js';

export interface UcpRailOptions {
  /** Core's base URL — the UCP callback intake lives there, per merchant. */
  coreBaseUrl: string;
  merchantSlug: string;
  /** The merchant's webhook secret — signature verification is on in EVERY
   * environment (§8), so the rail signs exactly like any UCP platform. */
  webhookSecret: string;
  /** The platform's own price book (integer pence — GBP_pence, never floats). */
  priceFor(sku: string): number;
  clock?: { now(): Date };
}

/**
 * The UCP execution rail (PH3-3): Valet checks out over the Unified Commerce
 * Protocol instead of FakeShop's proprietary API. The purchase and the
 * attribution callback are ONE act here — the rail plays the UCP platform's
 * part, echoing the `com.merited.attribution` extension envelope back on the
 * `ucp.checkout.completed` callback exactly as received (the token is opaque
 * and byte-identical, mapping rule 2), HMAC-signed over the raw bytes like
 * every other inbound delivery. The errand remains the idempotency scope:
 * a resumed errand replays the same order_ref and Idempotency-Key, never a
 * second order.
 */
export class UcpCheckoutRail implements CheckoutRail {
  constructor(private readonly options: UcpRailOptions) {}

  async checkout(request: CheckoutRequest): Promise<CheckoutConfirmation> {
    const clock = this.options.clock ?? { now: () => new Date() };
    const now = clock.now();
    const totalPence = this.options.priceFor(request.sku);
    // deterministic per errand — replays collapse to the same order
    const orderDigest = createHash('sha256').update(request.errand_id).digest('hex');
    const orderNumber = (parseInt(orderDigest.slice(0, 8), 16) % 900_000_000) + 1;

    const callback: UcpCheckoutCompleted = {
      type: 'ucp.checkout.completed',
      checkout_id: `ucp_chk_${orderDigest.slice(0, 24)}`,
      order: {
        order_ref: `ucp:${request.errand_id}`,
        total: { amount_minor: totalPence, currency: 'GBP' },
        completed_at: now.toISOString(),
        line_items: [{ sku: request.sku, quantity: 1 }],
        extensions:
          request.attribution_token === null
            ? {}
            : {
                [UCP_EXTENSION_KEY]: {
                  token: request.attribution_token,
                  // the platform echoes the envelope; these fields are its
                  // view of the offer it displayed — the token alone carries
                  // the attribution (qid/jti live inside it)
                  quote_id: 'ucp-platform-echo',
                  expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
                },
              },
      },
    };

    const rawBody = JSON.stringify(callback);
    const timestampS = Math.floor(now.getTime() / 1000);
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(webhookSignaturePayload(timestampS, rawBody))
      .digest('hex');

    const base = this.options.coreBaseUrl.replace(/\/$/, '');
    const response = await fetch(
      `${base}/v1/merchants/${this.options.merchantSlug}/ucp/checkout-completed`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestampS),
          [IDEMPOTENCY_KEY_HEADER]: `ucp:${request.errand_id}`,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 200) {
      throw new CheckoutFailedError(response.status, (await response.text()).slice(0, 200));
    }
    return { order_number: orderNumber, total_pence: totalPence, webhook: 'delivered' };
  }
}
