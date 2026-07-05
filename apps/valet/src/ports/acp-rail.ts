import { createHash, createHmac } from 'node:crypto';
import {
  ACP_EXPIRES_KEY,
  ACP_QUOTE_KEY,
  ACP_TOKEN_KEY,
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignaturePayload,
  type AcpOrderWebhook,
} from '@merited/contracts';
import { CheckoutFailedError, type CheckoutConfirmation, type CheckoutRail, type CheckoutRequest } from './checkout-rail.js';

export interface AcpRailOptions {
  /** Core's base URL — the ACP order-callback intake lives there, per merchant. */
  coreBaseUrl: string;
  merchantSlug: string;
  /** The merchant's webhook secret — signature verification is on in EVERY
   * environment (§8), so the rail signs exactly like any ACP platform. */
  webhookSecret: string;
  /** The platform's own price book (integer pence — GBP_pence, never floats). */
  priceFor(sku: string): number;
  clock?: { now(): Date };
}

/**
 * The ACP execution rail (PH3-4): Valet checks out over the Agentic Commerce
 * Protocol. Same shape as the UCP rail — the purchase and the attribution
 * callback are ONE act; the token is echoed verbatim in the flat metadata
 * map under the designated `merited:token` key (opaque and byte-identical,
 * mapping rule 2), HMAC-signed over the raw bytes like every other inbound
 * delivery. The errand remains the idempotency scope: a resumed errand
 * replays the same order_ref and Idempotency-Key, never a second order.
 */
export class AcpCheckoutRail implements CheckoutRail {
  constructor(private readonly options: AcpRailOptions) {}

  async checkout(request: CheckoutRequest): Promise<CheckoutConfirmation> {
    const clock = this.options.clock ?? { now: () => new Date() };
    const now = clock.now();
    const totalPence = this.options.priceFor(request.sku);
    // deterministic per errand — replays collapse to the same order
    const orderDigest = createHash('sha256').update(request.errand_id).digest('hex');
    const orderNumber = (parseInt(orderDigest.slice(0, 8), 16) % 900_000_000) + 1;

    const callback: AcpOrderWebhook = {
      object: 'acp.order',
      id: `acp_ord_${orderDigest.slice(0, 24)}`,
      order_ref: `acp:${request.errand_id}`,
      amount_minor: totalPence,
      currency: 'gbp',
      created_at: now.toISOString(),
      line_items: [{ sku: request.sku, quantity: 1 }],
      metadata:
        request.attribution_token === null
          ? {}
          : {
              // the platform echoes the merited:* metadata it displayed; the
              // token alone carries attribution (qid/jti live inside it)
              [ACP_TOKEN_KEY]: request.attribution_token,
              [ACP_QUOTE_KEY]: 'acp-platform-echo',
              [ACP_EXPIRES_KEY]: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
            },
    };

    const rawBody = JSON.stringify(callback);
    const timestampS = Math.floor(now.getTime() / 1000);
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(webhookSignaturePayload(timestampS, rawBody))
      .digest('hex');

    const base = this.options.coreBaseUrl.replace(/\/$/, '');
    const response = await fetch(
      `${base}/v1/merchants/${this.options.merchantSlug}/acp/order-completed`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestampS),
          [IDEMPOTENCY_KEY_HEADER]: `acp:${request.errand_id}`,
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
