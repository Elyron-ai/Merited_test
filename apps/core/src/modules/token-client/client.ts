import {
  MintRequest,
  MintResponse,
  TrioMintErrorCode,
  type MintFailure,
  type MintResult,
} from '@merited/contracts';
import { injectTraceparent } from '@merited/otel';

export interface TokenClientOptions {
  baseUrl: string;
  serviceToken: string;
  /** §5.6a: 2s hard budget — a slow mint must not stall the read path. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Typed mint client against the trio contract (CORE-9, §7.2/§1). NO
 * RETRIES — a retried mint would create an orphan jti; on any failure the
 * caller keeps the quote unpayable (`token: null`) rather than risking
 * duplicate tokens. Never throws for operational failures: every outcome
 * is a typed `MintResult`.
 */
export class TrioTokenClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TokenClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async mint(request: MintRequest): Promise<MintResult> {
    const body = MintRequest.parse(request);

    // W3C trace propagation (§8: one trace from readOffers to ledger) —
    // FND-14's helper carries the active span onto the outbound call.
    const headers = injectTraceparent({
      'content-type': 'application/json',
      'x-merited-service-token': this.options.serviceToken,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}/trio/tokens/mint`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return this.failure(
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }

    const text = await response.text();
    if (response.status === 200) {
      try {
        return { ok: true, minted: MintResponse.parse(JSON.parse(text)) };
      } catch {
        return this.failure('UNEXPECTED_RESPONSE', `unparseable 200 body: ${text.slice(0, 120)}`);
      }
    }
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string } };
      const code = TrioMintErrorCode.safeParse(parsed.error?.code);
      return this.failure(
        code.success ? code.data : 'UNEXPECTED_RESPONSE',
        `trio responded ${response.status}`,
      );
    } catch {
      return this.failure('UNEXPECTED_RESPONSE', `trio responded ${response.status}: ${text.slice(0, 120)}`);
    }
  }

  private failure(code: MintFailure['code'], message: string): MintResult {
    return { ok: false, error: { code, message } };
  }
}
