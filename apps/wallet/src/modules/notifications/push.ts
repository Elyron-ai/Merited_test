import { randomBytes } from 'node:crypto';
import { PushSubscription, type NotificationPayload } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import webpush from 'web-push';
import type pg from 'pg';
import { buildQuotePayload, type QuoteSummary } from './payloads.js';
import type { VapidConfig } from './vapid.js';

/**
 * Web Push (PH1-17, B25). First-party: our VAPID keys, the `web-push` lib,
 * the browser push service — no vendor. Subscriptions register into
 * `wallet.push_subscriptions`; `sendQuoteNotification` fans a quote summary
 * out to every subscription the consumer holds and emits ONE
 * `NotificationSent` per notification into the hash-chained ledger.
 *
 * The delivery seam (`PushTransport`) exists so CI captures and asserts the
 * payload without a real browser push service (the accept clause): the real
 * transport wraps `web-push` (VAPID-signed, aes128gcm-encrypted POST to the
 * subscription endpoint); the capturing fake records what would have been
 * pushed. A 404/410 from the push service means the subscription is dead —
 * it is pruned, the standard contract.
 */
export interface PushDelivery {
  subscription: PushSubscription;
  /** JSON-serialised NotificationPayload. */
  payload: string;
}

export interface PushTransport {
  /** Throws on delivery failure; an Error with `statusCode` 404/410 marks the
   * subscription dead. */
  deliver(delivery: PushDelivery, vapid: VapidConfig): Promise<void>;
}

/** Production transport — the real `web-push` wire. */
export class WebPushTransport implements PushTransport {
  async deliver(delivery: PushDelivery, vapid: VapidConfig): Promise<void> {
    await webpush.sendNotification(delivery.subscription, delivery.payload, {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 300,
    });
  }
}

/** CI transport — captures every would-be push for assertion. */
export class CapturingPushTransport implements PushTransport {
  readonly deliveries: PushDelivery[] = [];

  deliver(delivery: PushDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }
}

export interface PushServiceDeps {
  pool: pg.Pool;
  transport: PushTransport;
  vapid: VapidConfig;
  clock: { now(): Date };
}

export class PushService {
  constructor(private readonly deps: PushServiceDeps) {}

  /** Register (upsert) a browser push subscription for a consumer. */
  async register(consumerRef: string, subscription: PushSubscription): Promise<void> {
    const parsed = PushSubscription.parse(subscription);
    await this.deps.pool.query(
      `INSERT INTO wallet.push_subscriptions (consumer_ref, endpoint, keys)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (consumer_ref, endpoint) DO UPDATE SET keys = EXCLUDED.keys`,
      [consumerRef, parsed.endpoint, JSON.stringify(parsed.keys)],
    );
  }

  /**
   * Send-on-quote: build the payload (validated against the contract), push
   * to every subscription the consumer holds, prune dead ones, and emit
   * `NotificationSent`. Returns the payload so callers (PH1-18's approval
   * flow) can reuse it.
   */
  async sendQuoteNotification(
    consumerRef: string,
    quote: QuoteSummary,
  ): Promise<{ notification_id: string; payload: NotificationPayload; delivered: number }> {
    const payload = buildQuotePayload(quote, this.deps.clock.now());
    const serialised = JSON.stringify(payload);
    const { rows } = await this.deps.pool.query<{ endpoint: string; keys: PushSubscription['keys'] }>(
      `SELECT endpoint, keys FROM wallet.push_subscriptions WHERE consumer_ref = $1`,
      [consumerRef],
    );

    let delivered = 0;
    for (const row of rows) {
      const subscription = PushSubscription.parse({ endpoint: row.endpoint, keys: row.keys });
      try {
        await this.deps.transport.deliver({ subscription, payload: serialised }, this.deps.vapid);
        delivered += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // dead subscription — the push service says it no longer exists
          await this.deps.pool.query(
            `DELETE FROM wallet.push_subscriptions WHERE consumer_ref = $1 AND endpoint = $2`,
            [consumerRef, row.endpoint],
          );
        }
        // other failures: skip this endpoint, never fail the whole send
      }
    }

    const notificationId = `ntf_${randomBytes(13).toString('hex')}`;
    await appendEventInNewTx(this.deps.pool, 'NotificationSent', {
      notification_id: notificationId,
      consumer_ref: consumerRef,
      quote_id: quote.quote_id,
      sent_at: this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    return { notification_id: notificationId, payload, delivered };
  }
}
