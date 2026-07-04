import { MerchantKeyResponse, type MeritedId } from '@merited/contracts';
import { injectTraceparent } from '@merited/otel';
import { CoreHttpError } from '../../http-error.js';
import type { TrioKeyIssuer } from './service.js';

export interface TrioKeysClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}

/**
 * HTTP client for `POST /trio/keys/merchant` (SYN-22). Key issuance is an
 * operator action (control-plane onboarding), not a hot path: failures
 * throw a CoreHttpError for the envelope rather than a typed result union.
 */
export class TrioKeysClient implements TrioKeyIssuer {
  constructor(private readonly options: TrioKeysClientOptions) {}

  async issueMerchantKey(merchantId: MeritedId<'mer'>): Promise<MerchantKeyResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/trio/keys/merchant`, {
        method: 'POST',
        headers: injectTraceparent({
          'content-type': 'application/json',
          'x-merited-service-token': this.options.serviceToken,
        }),
        body: JSON.stringify({ merchant_id: merchantId }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new CoreHttpError(
        502,
        'TRIO_UNREACHABLE',
        error instanceof Error ? error.message : 'key issuance failed',
      );
    }
    if (response.status !== 200) {
      throw new CoreHttpError(502, 'KEY_ISSUANCE_FAILED', `trio responded ${response.status}`);
    }
    return MerchantKeyResponse.parse(await response.json());
  }
}
