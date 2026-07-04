import {
  Commitment,
  CommitmentCreateResponse,
  CommitmentStatus,
  type CommitmentDraft,
} from '@merited/contracts';
import { CoreHttpError } from '../../http-error.js';

export interface CommitmentIssuer {
  create(draft: CommitmentDraft): Promise<Commitment>;
  end(commitmentId: string, reason?: string): Promise<void>;
}

export interface TrioCommitmentsClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}

/**
 * HTTP client for §7.1 commitment signing (CORE-5). Publishing is an
 * operator/control-plane action, not a hot path — failures throw envelope
 * errors and the publish aborts before any local state changes.
 */
export class TrioCommitmentsClient implements CommitmentIssuer {
  constructor(private readonly options: TrioCommitmentsClientOptions) {}

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-merited-service-token': this.options.serviceToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new CoreHttpError(
        502,
        'TRIO_UNREACHABLE',
        error instanceof Error ? error.message : 'trio call failed',
      );
    }
  }

  async create(draft: CommitmentDraft): Promise<Commitment> {
    const response = await this.post('/trio/commitments', draft);
    if (response.status !== 200) {
      throw new CoreHttpError(502, 'COMMITMENT_CREATE_FAILED', `trio responded ${response.status}`);
    }
    return CommitmentCreateResponse.parse(await response.json()).commitment;
  }

  /** SYN-7 status read (eligibility stage 3). Unknown/unreachable → null —
   * the eligibility filter excludes unverifiable promises conservatively. */
  async status(commitmentId: string): Promise<CommitmentStatus | null> {
    try {
      const response = await fetch(`${this.options.baseUrl}/trio/commitments/${commitmentId}`, {
        headers: { 'x-merited-service-token': this.options.serviceToken },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      if (response.status !== 200) return null;
      return CommitmentStatus.parse(await response.json());
    } catch {
      return null;
    }
  }

  async end(commitmentId: string, reason?: string): Promise<void> {
    const response = await this.post(`/trio/commitments/${commitmentId}/end`, reason ? { reason } : {});
    // 409 ALREADY_ENDED is acceptable during a retried bounty edit — the goal
    // state (old COR ended) already holds.
    if (response.status !== 200 && response.status !== 409) {
      throw new CoreHttpError(502, 'COMMITMENT_END_FAILED', `trio responded ${response.status}`);
    }
  }
}
