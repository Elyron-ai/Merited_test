import { NotificationPayload } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { approvalDeepLink, buildQuotePayload, expiryCountdown, formatGBP } from './payloads.js';

/**
 * PH1-17 payload rules: validates against the NotificationPayload contract;
 * price is pence-formatted GBP (never floats); expiry is a countdown; the
 * deep link resolves to the approval screen for the SAME quote.
 */
const NOW = new Date('2026-07-05T12:00:00Z');
const QUOTE = {
  quote_id: 'qte_01J00000000000000000000000',
  offer_title: 'Full spa day — Aurora Club price',
  merchant_name: 'Aurora Experiences',
  final: { amount: 7183, currency: 'GBP_pence' as const },
  expires_at: '2026-07-05T12:14:00Z',
};

describe('notification payloads (PH1-17)', () => {
  it('builds a payload that validates against the NotificationPayload contract', () => {
    const payload = buildQuotePayload(QUOTE, NOW);
    expect(NotificationPayload.parse(payload)).toEqual(payload);
    expect(payload.title).toBe('Full spa day — Aurora Club price — £71.83');
    expect(payload.body).toContain('Aurora Experiences');
    expect(payload.body).toContain('£71.83');
    expect(payload.body).toContain('Expires in 14 minutes');
    expect(payload.quote.quote_id).toBe(QUOTE.quote_id);
    expect(payload.quote.final).toEqual(QUOTE.final);
  });

  it('the deep link resolves to the approval screen for the correct quote', () => {
    const payload = buildQuotePayload(QUOTE, NOW);
    expect(payload.deep_link).toBe('/approve/qte_01J00000000000000000000000');
    // resolving the link recovers the same quote the payload carries
    const resolved = payload.deep_link.match(/^\/approve\/(qte_[0-9A-HJKMNP-TV-Z]{26})$/);
    expect(resolved?.[1]).toBe(payload.quote.quote_id);
    expect(approvalDeepLink(QUOTE.quote_id)).toBe(payload.deep_link);
  });

  it('formats integer pence as GBP without floats: 7183 → £71.83, 500 → £5.00, 9 → £0.09', () => {
    expect(formatGBP({ amount: 7183, currency: 'GBP_pence' })).toBe('£71.83');
    expect(formatGBP({ amount: 500, currency: 'GBP_pence' })).toBe('£5.00');
    expect(formatGBP({ amount: 9, currency: 'GBP_pence' })).toBe('£0.09');
    expect(formatGBP({ amount: 100000, currency: 'GBP_pence' })).toBe('£1000.00');
  });

  it('expiry countdown: minutes, hours+minutes, and the sub-minute edge', () => {
    expect(expiryCountdown('2026-07-05T12:14:00Z', NOW)).toBe('14 minutes');
    expect(expiryCountdown('2026-07-05T12:01:00Z', NOW)).toBe('1 minute');
    expect(expiryCountdown('2026-07-05T14:05:00Z', NOW)).toBe('2 hours 5 minutes');
    expect(expiryCountdown('2026-07-05T13:00:00Z', NOW)).toBe('1 hour');
    expect(expiryCountdown('2026-07-05T12:00:30Z', NOW)).toBe('under a minute');
    expect(expiryCountdown('2026-07-05T11:00:00Z', NOW)).toBe('under a minute'); // already expired → floor at 0
  });
});
