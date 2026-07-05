import { Approval, Mandate } from '@merited/contracts';
import type { TrioDirectory } from './directory.js';

/**
 * TRIO-17: the LIVE directory — an HTTP client resolving approvals and
 * mandates from the wallet backend's `/internal/directory/*` lookup routes
 * at claim time. Strictly FAIL-CLOSED: a 404, a non-OK status, a network
 * error or an unparseable body all resolve to null (→ `APPROVAL_MISSING` /
 * `MANDATE_REVOKED` downstream). The pipeline still wraps this in
 * `VerifiedDirectory`, so every record fetched here has its attestation
 * verified against the platform key BEFORE anything trusts it (P3: never
 * trust monolith input unverified) — the wallet re-attests mandates over
 * their CURRENT state, so a revocation arrives as a verified fact, live,
 * with no cache window.
 */
export interface HttpDirectoryOptions {
  /** The wallet backend's base URL. */
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpDirectory implements TrioDirectory {
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpDirectoryOptions) {
    this.timeoutMs = options.timeoutMs ?? 2000;
  }

  private async lookup(path: string): Promise<unknown | null> {
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.options.baseUrl}${path}`, {
        headers: { 'x-merited-service-token': this.options.serviceToken },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null; // 404 unknown, 401 misconfigured — closed
      return await response.json();
    } catch {
      return null; // network/timeout/parse — closed
    }
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    const body = await this.lookup(`/internal/directory/approvals/${encodeURIComponent(approvalId)}`);
    const parsed = Approval.safeParse((body as { approval?: unknown } | null)?.approval);
    return parsed.success ? parsed.data : null;
  }

  async getMandate(mandateId: string): Promise<Mandate | null> {
    const body = await this.lookup(`/internal/directory/mandates/${encodeURIComponent(mandateId)}`);
    const parsed = Mandate.safeParse((body as { mandate?: unknown } | null)?.mandate);
    return parsed.success ? parsed.data : null;
  }
}
