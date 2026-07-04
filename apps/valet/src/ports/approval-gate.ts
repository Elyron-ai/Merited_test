import type { ErrandEvent, OfferQuote } from '@merited/contracts';

export type ApprovalOutcome = Extract<
  ErrandEvent,
  { type: 'APPROVAL_REQUESTED' | 'APPROVAL_GRANTED' | 'APPROVAL_SKIPPED' | 'APPROVAL_DECLINED' }
>;

/** Consulted at QUOTED (VAL-5/D4). Phase 2's wallet gate pushes a
 * notification and waits; Phase 0 has no wallet, so the gate records the
 * skip and the errand still passes through APPROVED with an audit trail. */
export interface ApprovalGate {
  consult(quote: OfferQuote): Promise<ApprovalOutcome>;
}

export class AutoSkipGate implements ApprovalGate {
  async consult(): Promise<ApprovalOutcome> {
    return { type: 'APPROVAL_SKIPPED', reason: 'walletless' };
  }
}
