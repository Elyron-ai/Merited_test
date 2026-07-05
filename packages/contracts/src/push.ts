import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';

/**
 * Web Push shapes (PH1-1 → PH1-17, B25). `PushSubscription` mirrors the
 * browser's PushSubscription.toJSON(); `NotificationPayload` is the quote
 * summary + deep link the approval screen opens from (§6.3 screen 4).
 */

export const PushSubscription = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscription = z.infer<typeof PushSubscription>;

export const NotificationPayload = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  quote: z.object({
    quote_id: Id('qte'),
    offer_title: z.string().min(1),
    merchant_name: z.string().min(1),
    final: Money,
    expires_at: z.string().datetime(),
  }),
  /** Wallet route the notification opens (approval screen). */
  deep_link: z.string().min(1),
});
export type NotificationPayload = z.infer<typeof NotificationPayload>;
