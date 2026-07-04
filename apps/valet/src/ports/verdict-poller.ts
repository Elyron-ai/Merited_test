import type { ErrandEvent } from '@merited/contracts';
import { MeritedApiError } from '@merited/sdk';
import type { QuoteClient } from './quote-client.js';

export type VerdictEvent = Extract<ErrandEvent, { type: 'CLAIM_VERIFIED' | 'CLAIM_REJECTED' }>;

export class VerdictTimeoutError extends Error {
  constructor(quoteId: string, attempts: number) {
    super(`no verdict for quote ${quoteId} after ${attempts} attempts`);
    this.name = 'VerdictTimeoutError';
  }
}

export interface VerdictPollerOptions {
  client: Pick<QuoteClient, 'getQuoteClaim'>;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Backoff cap (VAL-5: "capped backoff"). */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls the agent's own quote for its claim verdict (VAL-5, via SYN-40's
 * discovery route). 404 means "no claim yet"; a pending verdict keeps
 * polling; verified/rejected map straight onto the reducer's events. The
 * timeout surfaces as a thrown error the driver turns into `TIMED_OUT`.
 */
export class VerdictPoller {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: VerdictPollerOptions) {
    this.maxAttempts = options.maxAttempts ?? 30;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async poll(quoteId: string): Promise<VerdictEvent> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const claim = await this.options.client.getQuoteClaim(quoteId);
        if (claim.verdict === 'verified') {
          return { type: 'CLAIM_VERIFIED', claim_id: claim.claim_id as `clm_${string}` };
        }
        if (claim.verdict === 'rejected' && claim.reason_code) {
          return { type: 'CLAIM_REJECTED', reason_code: claim.reason_code };
        }
        // pending — fall through to backoff
      } catch (error) {
        const notYet = error instanceof MeritedApiError && error.status === 404;
        if (!notYet) throw error;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs));
      }
    }
    throw new VerdictTimeoutError(quoteId, this.maxAttempts);
  }
}
