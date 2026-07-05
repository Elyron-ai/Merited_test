import { NotificationPayload, type Money } from '@merited/contracts';

/**
 * Notification payload builder (PH1-17, B25). Payload = the quote summary —
 * offer title, final price (integer pence, formatted GBP), expiry countdown —
 * plus the deep link to the approval screen (`/approve/:quote_id`, §6.3
 * screen 4). Everything validates against the `NotificationPayload` contract
 * before it leaves this module.
 */
export interface QuoteSummary {
  quote_id: string;
  offer_title: string;
  merchant_name: string;
  final: Money;
  expires_at: string;
}

/** Integer pence → UK-formatted pounds: 7183 → £71.83 (never floats). */
export const formatGBP = (money: Money): string => {
  const pounds = Math.floor(money.amount / 100);
  const pennies = money.amount % 100;
  return `£${pounds}.${pennies.toString().padStart(2, '0')}`;
};

/** Human expiry countdown: "14 minutes", "2 hours 5 minutes", "under a minute". */
export const expiryCountdown = (expiresAt: string, now: Date): string => {
  const remainingS = Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  if (remainingS < 60) return 'under a minute';
  const hours = Math.floor(remainingS / 3600);
  const minutes = Math.floor((remainingS % 3600) / 60);
  const minutePart = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (hours === 0) return minutePart;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return minutes === 0 ? hourPart : `${hourPart} ${minutePart}`;
};

/** The wallet route a notification opens — the approval screen for the quote. */
export const approvalDeepLink = (quoteId: string): string => `/approve/${quoteId}`;

export const buildQuotePayload = (quote: QuoteSummary, now: Date): NotificationPayload =>
  NotificationPayload.parse({
    title: `${quote.offer_title} — ${formatGBP(quote.final)}`,
    body: `${quote.merchant_name}: ${formatGBP(quote.final)} locked for you. Expires in ${expiryCountdown(quote.expires_at, now)}. Tap to approve.`,
    quote: {
      quote_id: quote.quote_id,
      offer_title: quote.offer_title,
      merchant_name: quote.merchant_name,
      final: quote.final,
      expires_at: quote.expires_at,
    },
    deep_link: approvalDeepLink(quote.quote_id),
  });
