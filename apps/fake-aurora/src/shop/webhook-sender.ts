import { createHmac } from 'node:crypto';
import {
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignaturePayload,
  type FakeShopOrderWebhook,
} from '@merited/contracts';

export interface WebhookDeliveryOptions {
  adapterUrl: string;
  secret: string;
  idempotencyKey: string;
  traceparent?: string;
  /** Injected for tests; wall clock in production use. */
  nowS?: () => number;
  maxAttempts?: number;
  backoffMs?: number;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
}

/**
 * Signed order-confirmed delivery (MER-11): HMAC-SHA256 hex over the shared
 * `${timestamp}.${rawBody}` layout, Idempotency-Key = order id (every retry
 * reuses it — exercising MER-3's replay path for real), traceparent
 * forwarded from the checkout request (§8 single trace). Retries with
 * backoff on non-2xx / network failure.
 */
export const deliverOrderWebhook = async (
  payload: FakeShopOrderWebhook,
  options: WebhookDeliveryOptions,
): Promise<DeliveryResult> => {
  const rawBody = JSON.stringify(payload);
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 100;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timestampS = (options.nowS ?? (() => Math.floor(Date.now() / 1000)))();
    const signature = createHmac('sha256', options.secret)
      .update(webhookSignaturePayload(timestampS, rawBody), 'utf8')
      .digest('hex');
    try {
      const response = await fetch(options.adapterUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestampS),
          [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey,
          ...(options.traceparent ? { traceparent: options.traceparent } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 200 && response.status < 300) {
        return { delivered: true, attempts: attempt };
      }
    } catch {
      // fall through to retry
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
    }
  }
  return { delivered: false, attempts: maxAttempts };
};
