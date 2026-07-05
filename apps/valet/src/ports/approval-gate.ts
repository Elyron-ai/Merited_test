import {
  ApprovalRequestStatus,
  type ErrandEvent,
  type MeritedId,
  type Money,
} from '@merited/contracts';

export type ApprovalOutcome = Extract<
  ErrandEvent,
  { type: 'APPROVAL_REQUESTED' | 'APPROVAL_GRANTED' | 'APPROVAL_SKIPPED' | 'APPROVAL_DECLINED' }
>;

/** What an approval decision is ABOUT: the quote's identity, its final
 * price (the mandate-limit comparison input), its deadline — and, wallet
 * path (PH2-4), the mandate the errand runs under. */
export interface ApprovalContext {
  quote_id: string;
  final: Money;
  expires_at: string;
  mandate_id?: MeritedId<'mnd'> | null;
}

/** Consulted at QUOTED (VAL-5/D4); polled at AWAITING_APPROVAL (PH2-4).
 * Phase 0 has no wallet, so the gate records the skip and the errand still
 * passes through APPROVED with an audit trail. */
export interface ApprovalGate {
  consult(context: ApprovalContext): Promise<ApprovalOutcome>;
  /** The AWAITING_APPROVAL poll: the consumer's decision when one exists,
   * null while still pending. Gates without interactive approval omit it. */
  check?(context: ApprovalContext): Promise<ApprovalOutcome | null>;
}

export class AutoSkipGate implements ApprovalGate {
  async consult(): Promise<ApprovalOutcome> {
    return { type: 'APPROVAL_SKIPPED', reason: 'walletless' };
  }
}

/**
 * The live wallet gate (PH2-4, §6.6): consult() files an approval request
 * with the wallet — a quote at/below the mandate's `pre_authorised_up_to`
 * comes back approved on the spot (implicit Approval recorded, token
 * re-minted), anything above parks the errand in AWAITING_APPROVAL while
 * the consumer decides on their phone. check() is the park-bench poll.
 * Valet stays an ORDINARY agent on public wallet APIs (P5): requesting
 * grants nothing, and the re-minted token only exists if the mandate
 * holder's wallet authorised it.
 */
export class WalletApprovalGate implements ApprovalGate {
  constructor(private readonly options: { walletBaseUrl: string; fetchImpl?: typeof fetch }) {}

  private async request(
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
  ): Promise<ApprovalRequestStatus | null> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`${this.options.walletBaseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { request: unknown };
    const parsed = ApprovalRequestStatus.safeParse(payload.request);
    return parsed.success ? parsed.data : null;
  }

  private outcomeFrom(request: ApprovalRequestStatus | null): ApprovalOutcome | null {
    if (!request) return null;
    switch (request.status) {
      case 'approved':
        return {
          type: 'APPROVAL_GRANTED',
          approval_id: request.approval_id!,
          mode: request.mode ?? 'explicit',
          token: request.token,
        };
      case 'declined':
      case 'refused': // the mandate can never authorise this quote — over
      case 'expired': // to the reducer as a decline; the mirror keeps WHY
        return { type: 'APPROVAL_DECLINED' };
      case 'pending':
        return null;
    }
  }

  async consult(context: ApprovalContext): Promise<ApprovalOutcome> {
    if (!context.mandate_id) return { type: 'APPROVAL_SKIPPED', reason: 'walletless' };
    const request = await this.request('POST', '/v1/approval-requests', {
      quote_id: context.quote_id,
      mandate_id: context.mandate_id,
    });
    // fail closed: an unreachable wallet parks the errand rather than buying
    return this.outcomeFrom(request) ?? { type: 'APPROVAL_REQUESTED' };
  }

  async check(context: ApprovalContext): Promise<ApprovalOutcome | null> {
    const request = await this.request('GET', `/v1/approval-requests/${context.quote_id}`);
    return this.outcomeFrom(request);
  }
}
