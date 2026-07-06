import { createHmac } from 'node:crypto';
import { webhookSignaturePayload } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { precheckWebhook, verifyWebhookSignature } from './verify.js';

/**
 * W4/#34: `precheckWebhook` is the SECRET-FREE portion (header presence,
 * format, skew) so a route can reject a header-less / stale / malformed
 * delivery BEFORE fetching + decrypting the merchant secrets.
 */
describe('precheckWebhook (secret-free pre-gate)', () => {
  const base = { nowS: 1_000_000, maxSkewS: 300 };

  it('rejects a missing signature header', () => {
    expect(precheckWebhook({ ...base, signatureHeader: undefined, timestampHeader: '1000000' }))
      .toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a missing / non-numeric timestamp', () => {
    expect(precheckWebhook({ ...base, signatureHeader: 'sig', timestampHeader: undefined }))
      .toEqual({ ok: false, reason: 'missing_timestamp' });
    expect(precheckWebhook({ ...base, signatureHeader: 'sig', timestampHeader: 'not-a-number' }))
      .toEqual({ ok: false, reason: 'missing_timestamp' });
  });

  it('rejects a timestamp outside the skew bound', () => {
    expect(precheckWebhook({ ...base, signatureHeader: 'sig', timestampHeader: String(base.nowS - 400) }))
      .toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('passes fresh, well-formed headers and returns the parsed timestamp', () => {
    expect(precheckWebhook({ ...base, signatureHeader: 'sig', timestampHeader: '1000000' }))
      .toEqual({ ok: true, timestampS: 1_000_000 });
  });
});

describe('verifyWebhookSignature (HMAC over the pre-gate)', () => {
  const secret = 'whsec_test';
  const nowS = 1_000_000;
  const rawBody = '{"event":"order.confirmed"}';
  const sig = createHmac('sha256', secret).update(webhookSignaturePayload(nowS, rawBody)).digest('hex');

  it('accepts a correct signature and rejects a wrong one', () => {
    expect(
      verifyWebhookSignature({ rawBody, signatureHeader: sig, timestampHeader: String(nowS), secrets: [secret], nowS, maxSkewS: 300 }),
    ).toEqual({ ok: true });
    expect(
      verifyWebhookSignature({ rawBody, signatureHeader: 'deadbeef', timestampHeader: String(nowS), secrets: [secret], nowS, maxSkewS: 300 }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('short-circuits on the pre-gate before touching secrets (missing header)', () => {
    // an empty secrets list would make a real HMAC attempt fail 'bad_signature';
    // a header-less request must fail 'missing_signature' first, proving the
    // pre-gate runs before the (route-side) secret fetch/decrypt.
    expect(
      verifyWebhookSignature({ rawBody, signatureHeader: undefined, timestampHeader: String(nowS), secrets: [], nowS, maxSkewS: 300 }),
    ).toEqual({ ok: false, reason: 'missing_signature' });
  });
});
