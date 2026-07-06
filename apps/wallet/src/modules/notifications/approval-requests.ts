import type { ApprovalRequestStatus } from '@merited/contracts';
import type pg from 'pg';
import type { MandateService } from '../mandates/mandate-service.js';
import type { ApprovalsService, ApproveResult, QuoteGateway } from './approvals.js';
import type { PushService } from './push.js';

/**
 * Approval requests (PH2-4, §6.6): the agent↔wallet rendezvous. `create`
 * is the production caller of PH1-17's `sendQuoteNotification` — an agent
 * holding a mandate-minted quote asks here; a quote at/below the mandate's
 * `pre_authorised_up_to` is approved IMPLICITLY on the spot (Approval
 * recorded, token re-minted — the consumer pre-authorised it when granting
 * the mandate), anything above pushes a notification and waits for the
 * consumer's explicit decision through PH1-18's approve/decline endpoints,
 * which resolve the row via `recordDecision`. Requesting grants nothing:
 * every authorisation decision stays inside MandateService (P3).
 */

export interface ApprovalRequestsDeps {
  pool: pg.Pool;
  mandates: MandateService;
  approvals: ApprovalsService;
  quotes: QuoteGateway;
  clock: { now(): Date };
  push?: PushService;
  /** Offer/merchant copy for the push payload; plain fallbacks otherwise. */
  quoteCopyFor?(quoteId: string): Promise<{ offer_title: string; merchant_name: string } | null>;
}

interface RequestRow {
  quote_id: string;
  status: ApprovalRequestStatus['status'];
  reason: string | null;
  mode: 'explicit' | 'pre_authorised' | null;
  approval_id: string | null;
  token: string | null;
}

const toStatus = (row: RequestRow): ApprovalRequestStatus => ({
  quote_id: row.quote_id as `qte_${string}`,
  status: row.status,
  reason: row.reason,
  mode: row.mode,
  approval_id: row.approval_id as `apr_${string}` | null,
  token: row.token,
});

export class ApprovalRequestsService {
  constructor(private readonly deps: ApprovalRequestsDeps) {}

  async create(input: { quoteId: string; mandateId: string }): Promise<ApprovalRequestStatus | null> {
    // idempotent per quote: a repeated request returns the standing row
    const existing = await this.status(input.quoteId);
    if (existing) return existing;

    const quote = await this.deps.quotes.getQuote(input.quoteId);
    if (!quote) return null; // 404 — nothing to approve

    const mandate = await this.deps.mandates.get(input.mandateId);
    if (!mandate) return null;

    // SECURITY — the mandate may authorise ONLY quotes that belong to its own
    // agent (and consumer). Without this binding an unauthenticated caller who
    // learns any quote_id + any mandate_id could drive an implicit approval
    // against a DIFFERENT consumer's mandate and receive the convertible
    // re-minted token. A mismatch is a uniform not-found (404) — no
    // cross-tenant existence oracle, and no row is persisted for the pair.
    if (quote.agent_id !== mandate.agent_id) return null;
    if (quote.consumer_ref !== null && quote.consumer_ref !== mandate.consumer_ref) return null;

    if (Date.parse(quote.expires_at) <= this.deps.clock.now().getTime()) {
      return this.persist(input, mandate.consumer_ref, {
        status: 'expired',
        reason: 'APPROVAL_EXPIRED',
      });
    }

    if (quote.final.amount <= mandate.pre_authorised_up_to.amount) {
      // implicit path (arch §4.3): authorise records the pre_authorised
      // Approval; the shared approve pipeline re-mints against it — one
      // code path for limits, liveness, attestation and idempotency
      const authorised = await this.deps.mandates.authoriseForQuote({
        mandateId: input.mandateId,
        quoteId: input.quoteId,
        orderValue: quote.final,
        quoteExpiresAt: quote.expires_at,
      });
      if (authorised.outcome !== 'pre_authorised' && authorised.outcome !== 'approved') {
        return this.persist(input, mandate.consumer_ref, {
          status: 'refused',
          reason: authorised.outcome,
        });
      }
      const approved = await this.deps.approvals.approve({
        consumerRef: mandate.consumer_ref,
        quoteId: input.quoteId,
        mandateId: input.mandateId,
        idempotencyKey: `aprq/${input.quoteId}`,
      });
      if (approved.outcome !== 'approved') {
        return this.persist(input, mandate.consumer_ref, {
          status: 'refused',
          reason: approved.outcome,
        });
      }
      return this.persist(input, mandate.consumer_ref, {
        status: 'approved',
        mode: approved.approval.mode,
        approval_id: approved.approval.approval_id,
        token: approved.token,
      });
    }

    // explicit path: notify the consumer (PH1-17's production caller) and wait
    const copy = (await this.deps.quoteCopyFor?.(input.quoteId)) ?? null;
    await this.deps.push?.sendQuoteNotification(mandate.consumer_ref, {
      quote_id: input.quoteId,
      offer_title: copy?.offer_title ?? 'An offer found by your agent',
      merchant_name: copy?.merchant_name ?? 'Merited',
      final: quote.final,
      expires_at: quote.expires_at,
    });
    return this.persist(input, mandate.consumer_ref, { status: 'pending' });
  }

  async status(quoteId: string): Promise<ApprovalRequestStatus | null> {
    const { rows } = await this.deps.pool.query<RequestRow>(
      `SELECT quote_id, status, reason, mode, approval_id, token
         FROM wallet.approval_requests WHERE quote_id = $1`,
      [quoteId],
    );
    return rows[0] ? toStatus(rows[0]) : null;
  }

  /** Called by the approve/decline routes after the consumer decides —
   * the valet's next poll sees the outcome (and the re-minted token). */
  async recordDecision(quoteId: string, decision: ApproveResult | { outcome: 'declined' }): Promise<void> {
    if (decision.outcome === 'approved') {
      await this.deps.pool.query(
        `UPDATE wallet.approval_requests
            SET status = 'approved', mode = $2, approval_id = $3, token = $4, decided_at = now()
          WHERE quote_id = $1 AND status = 'pending'`,
        [quoteId, decision.approval.mode, decision.approval.approval_id, decision.token],
      );
      return;
    }
    if (decision.outcome === 'declined') {
      await this.deps.pool.query(
        `UPDATE wallet.approval_requests
            SET status = 'declined', decided_at = now()
          WHERE quote_id = $1 AND status = 'pending'`,
        [quoteId],
      );
    }
    // a failed approve (LIMIT_EXCEEDED etc.) leaves the request pending: the
    // consumer may retry with another mandate before the quote expires
  }

  private async persist(
    input: { quoteId: string; mandateId: string },
    consumerRef: string,
    outcome: Partial<Pick<RequestRow, 'status' | 'reason' | 'mode' | 'approval_id' | 'token'>> &
      Pick<RequestRow, 'status'>,
  ): Promise<ApprovalRequestStatus> {
    const decided = outcome.status !== 'pending';
    const { rows } = await this.deps.pool.query<RequestRow>(
      `INSERT INTO wallet.approval_requests
         (quote_id, mandate_id, consumer_ref, status, reason, mode, approval_id, token, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${decided ? 'now()' : 'NULL'})
       ON CONFLICT (quote_id) DO NOTHING
       RETURNING quote_id, status, reason, mode, approval_id, token`,
      [
        input.quoteId,
        input.mandateId,
        consumerRef,
        outcome.status,
        outcome.reason ?? null,
        outcome.mode ?? null,
        outcome.approval_id ?? null,
        outcome.token ?? null,
      ],
    );
    if (rows[0]) return toStatus(rows[0]);
    return (await this.status(input.quoteId))!; // raced: the standing row wins
  }
}
