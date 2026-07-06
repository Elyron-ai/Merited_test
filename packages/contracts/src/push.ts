import { z } from 'zod';
import { Id } from './ids.js';
import { Money } from './money.js';

/**
 * Web Push shapes (PH1-1 → PH1-17, B25). `PushSubscription` mirrors the
 * browser's PushSubscription.toJSON(); `NotificationPayload` is the quote
 * summary + deep link the approval screen opens from (§6.3 screen 4).
 */

/**
 * W11 (web-push SSRF): the endpoint is a URL the wallet POSTs a VAPID-signed
 * request to. Unguarded, a consumer could register `http://169.254.169.254/…`
 * (cloud metadata) or an internal host and turn the wallet into a blind SSRF
 * proxy. Require https and reject non-public hosts. This is a STATIC check —
 * a hostname that RESOLVES to a private IP (DNS rebinding) is a runtime/deploy
 * concern tracked in docs/launch-readiness.md, not something a schema can see.
 */
const PRIVATE_IPV4 = [
  /^0\./, // "this" network
  /^10\./, // private
  /^127\./, // loopback
  /^169\.254\./, // link-local (incl. 169.254.169.254 cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^192\.168\./, // private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

export const isPublicHttpsEndpoint = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // hostname strips the port; drop IPv6 brackets and lower-case for matching
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;

  // An IPv6 literal always contains a colon — check those rules ONLY here so a
  // regular hostname like `fcm.googleapis.com` is never mistaken for fc00::/7.
  if (host.includes(':')) {
    // loopback (::1), unspecified (::), link-local (fe80::/10), unique-local
    // (fc00::/7 → fc/fd), and every IPv4-mapped address (::ffff:… — Node may
    // normalise the tail to hex, so reject the whole class).
    if (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fe80:') ||
      /^f[cd]/.test(host) ||
      host.startsWith('::ffff:')
    ) {
      return false;
    }
    return true; // any other global IPv6 is allowed
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }
  if (PRIVATE_IPV4.some((re) => re.test(host))) return false;
  return true;
};

export const PushSubscription = z.object({
  endpoint: z
    .string()
    .url()
    .refine(isPublicHttpsEndpoint, {
      message: 'endpoint must be an https URL to a public host (SSRF guard)',
    }),
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
