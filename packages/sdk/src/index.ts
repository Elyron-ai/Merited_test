import {
  AgentRegistrationResponse,
  ClaimStatusResponse,
  ClaimSubmitResponse,
  ConversionClaim,
  OfferReadResponse,
  QuoteStatusResponse,
  SingleOfferResponse,
  type RejectionReasonCode,
} from '@merited/contracts';

/**
 * @merited/sdk (CORE-13, B9) — the typed public-API client. Fetch-based;
 * ZERO runtime dependencies beyond `@merited/contracts`; every response is
 * validated against the contracts Zod schemas, so consumers can trust the
 * types at runtime. NO types are defined in this package (§1: contracts is
 * the single source) — the hygiene test greps for exported type/interface.
 *
 * Consumers: Valet v0 (an ordinary registered agent, P5), the demo scripts
 * (VAL-12) and FakeShop's checkout hand-off.
 */

/** Typed API failure carrying the §3 reason code when the platform sent one. */
export class MeritedApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly reasonCode?: RejectionReasonCode,
  ) {
    super(`merited api ${status}: ${code}${reasonCode ? ` (${reasonCode})` : ''}`);
    this.name = 'MeritedApiError';
  }
}

export class MeritedClient {
  private apiKey: string | undefined;
  private readonly merchantApiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly traceHeaders: (() => Record<string, string>) | undefined;

  constructor(options: {
    baseUrl: string;
    /** Agent key (`mak_…`) for the read path. Set automatically by register(). */
    apiKey?: string;
    /** Merchant key (`mmk_…`) — required only for submitClaim(). */
    merchantApiKey?: string;
    /** Extra-headers hook for callers WITHOUT @merited/otel (zero-dep rule:
     * the caller owns tracing). Apps running `initOtel` must NOT set this —
     * fetch is auto-instrumented there, and a manual traceparent would
     * double-inject and break W3C extraction. */
    traceHeaders?: () => Record<string, string>;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.merchantApiKey = options.merchantApiKey;
    this.traceHeaders = options.traceHeaders;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.traceHeaders ? this.traceHeaders() : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      const envelope = parsed as
        | { error?: { code?: string; reason_code?: RejectionReasonCode }; reason_code?: RejectionReasonCode }
        | undefined;
      throw new MeritedApiError(
        response.status,
        envelope?.error?.code ?? 'UNEXPECTED_RESPONSE',
        envelope?.error?.reason_code ?? envelope?.reason_code,
      );
    }
    return parsed;
  }

  private agentHeaders(): Record<string, string> {
    return this.apiKey ? { 'x-merited-agent-key': this.apiKey } : {};
  }

  /** Open registration. The returned api_key is adopted by this client
   * instance when it has none (the Valet bootstrap flow). */
  async register(input: { name: string; contact: string }): Promise<AgentRegistrationResponse> {
    const body = AgentRegistrationResponse.parse(
      await this.request('POST', '/v1/agents/register', { body: input }),
    );
    this.apiKey ??= body.api_key;
    return body;
  }

  async readOffers(
    query: Record<string, string | undefined> = {},
  ): Promise<OfferReadResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return OfferReadResponse.parse(
      await this.request('GET', `/v1/offers${suffix}`, { headers: this.agentHeaders() }),
    );
  }

  async getOffer(offerId: string): Promise<SingleOfferResponse> {
    return SingleOfferResponse.parse(
      await this.request('GET', `/v1/offers/${offerId}`, { headers: this.agentHeaders() }),
    );
  }

  async getQuote(quoteId: string): Promise<QuoteStatusResponse> {
    return QuoteStatusResponse.parse(
      await this.request('GET', `/v1/quotes/${quoteId}`, { headers: this.agentHeaders() }),
    );
  }

  async submitClaim(
    claim: ConversionClaim,
    options: { idempotencyKey: string },
  ): Promise<ClaimSubmitResponse> {
    if (!this.merchantApiKey) {
      throw new MeritedApiError(0, 'MERCHANT_KEY_REQUIRED');
    }
    return ClaimSubmitResponse.parse(
      await this.request('POST', '/v1/claims', {
        body: ConversionClaim.parse(claim),
        headers: {
          'x-merited-merchant-key': this.merchantApiKey,
          'idempotency-key': options.idempotencyKey,
        },
      }),
    );
  }

  /** Agent-side verdict discovery (SYN-40): the latest claim consuming the
   * agent's own quote. 404 (`CLAIM_NOT_FOUND`) while no claim has arrived —
   * the VerdictPoller treats that as "keep waiting". */
  async getQuoteClaim(quoteId: string): Promise<ClaimStatusResponse> {
    return ClaimStatusResponse.parse(
      await this.request('GET', `/v1/quotes/${quoteId}/claim`, { headers: this.agentHeaders() }),
    );
  }

  async getClaim(claimId: string): Promise<ClaimStatusResponse> {
    return ClaimStatusResponse.parse(
      await this.request('GET', `/v1/claims/${claimId}`, {
        headers: {
          ...this.agentHeaders(),
          ...(this.merchantApiKey ? { 'x-merited-merchant-key': this.merchantApiKey } : {}),
        },
      }),
    );
  }
}
export { AgentRequestSigner, generateAgentKeypair, type SignRequestInput } from './signed-client.js';
