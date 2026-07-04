import { createHmac, timingSafeEqual } from 'node:crypto';
import { webhookSignaturePayload } from '@merited/contracts';

export interface WebhookVerificationInput {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  /** Every LIVE secret (graceful rotation — SYN-39). */
  secrets: readonly string[];
  nowS: number;
  maxSkewS: number;
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'missing_timestamp' | 'stale_timestamp' | 'bad_signature' };

/**
 * Grade-B HMAC verification (MER-3, §5.8/§8 — ON in every environment,
 * including dev/CI). HMAC-SHA256 hex over the shared
 * `${timestamp}.${rawBody}` layout; timestamp skew bounded; comparison is
 * constant-time against every live secret (rotation overlap).
 */
export const verifyWebhookSignature = (input: WebhookVerificationInput): WebhookVerification => {
  if (!input.signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!input.timestampHeader || !/^\d+$/.test(input.timestampHeader)) {
    return { ok: false, reason: 'missing_timestamp' };
  }
  const timestampS = Number(input.timestampHeader);
  if (Math.abs(input.nowS - timestampS) > input.maxSkewS) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const presented = Buffer.from(input.signatureHeader, 'utf8');
  for (const secret of input.secrets) {
    const expected = Buffer.from(
      createHmac('sha256', secret)
        .update(webhookSignaturePayload(timestampS, input.rawBody), 'utf8')
        .digest('hex'),
      'utf8',
    );
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
};
