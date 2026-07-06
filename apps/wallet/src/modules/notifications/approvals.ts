import { type Approval, type MintRequest, type MintResponse, type Money } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import type pg from 'pg';
import type { MandateService } from '../mandates/mandate-service.js';
import type { PushService } from './push.js';

/**
 * Approvals (PH1-18, B26 — §6.4). `POST /v1/quotes/:id/approve`:
 *
 *   quote liveness (an expired quote can no longer be approved →
 *   `APPROVAL_EXPIRED`) → mandate live-checks + signed EXPLICIT `Approval`
 *   through PH1-16's single code path (`exp = quote.expires_at`, single-use
 *   per quote, `ApprovalGranted`) → RE-MINT from the trio mint — same `qid`,
 *   fresh `jti`, `apr` set (§7.2) → Approval + fresh token returned.
 *
 * Declines emit `ApprovalDeclined` and expire any errand awaiting this quote
 * gracefully. The endpoint is idempotent under `Idempotency-Key` (§8): a
 * replay returns the ORIGINAL response — critically, the SAME re-minted
 * token, never a fresh jti.
 */

/** How the wallet reads a quote. Pg-backed over `core.quotes` in the
 * single-database phase; an HTTP client against core replaces it at the
 * split-topology point behind this same port. */
export interface QuoteGateway {
  getQuote(quoteId: string): Promise<QuoteView | null>;
}

export interface QuoteView {
  quote_id: string;
  commitment_id: string;
  agent_id: string | null;
  consumer_ref: string | null;
  tier: 'T1' | 'T2' | 'T3';
  final: Money;
  expires_at: string;
}

export class PgQuoteReader implements QuoteGateway {
  constructor(private readonly pool: pg.Pool) {}

  async getQuote(quoteId: string): Promise<QuoteView | null> {
    const { rows } = await this.pool.query<{
      quote_id: string;
      commitment_id: string;
      agent_id: string | null;
      consumer_ref: string | null;
      tier: 'T1' | 'T2' | 'T3';
      final_amount: number;
      expires_at: Date;
    }>(
      `SELECT quote_id, commitment_id, agent_id, consumer_ref, tier, final_amount, expires_at
         FROM core.quotes WHERE quote_id = $1`,
      [quoteId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      quote_id: r.quote_id,
      commitment_id: r.commitment_id,
      agent_id: r.agent_id,
      consumer_ref: r.consumer_ref,
      tier: r.tier,
      final: { amount: Number(r.final_amount), currency: 'GBP_pence' },
      expires_at: new Date(r.expires_at).toISOString(),
    };
  }
}

/** The re-mint call (§7.2) — core's TrioTokenClient injected as a function,
 * or the in-process mint simulator in tests. Null = mint refused/failed. */
export type ReMint = (request: MintRequest) => Promise<MintResponse | null>;

export type ApproveResult =
  | { outcome: 'approved'; approval: Approval; token: string; token_expires_at: string }
  | { outcome: 'QUOTE_NOT_FOUND' }
  | { outcome: 'APPROVAL_EXPIRED' }
  | { outcome: 'MANDATE_REVOKED' }
  | { outcome: 'LIMIT_EXCEEDED' }
  | { outcome: 'CHECKOUT_SCOPE_MISSING' }
  | { outcome: 'APPROVAL_MISSING' } // structurally possible from the gate; not produced here
  | { outcome: 'REMINT_FAILED' };

export interface ApprovalsServiceDeps {
  pool: pg.Pool;
  mandates: MandateService;
  quotes: QuoteGateway;
  reMint: ReMint;
  clock: { now(): Date };
  /** PH1-17: notify-on-quote hook (the approval screen's push). Optional —
   * the approve/decline flow never depends on push delivery. */
  push?: PushService;
}

export class ApprovalsService {
  constructor(private readonly deps: ApprovalsServiceDeps) {}

  async approve(input: {
    consumerRef: string;
    quoteId: string;
    mandateId: string;
    idempotencyKey?: string;
  }): Promise<ApproveResult> {
    // §8 idempotency: a replayed key returns the ORIGINAL result verbatim —
    // same approval, same token, no second mint.
    if (input.idempotencyKey) {
      const replay = await this.deps.pool.query<{ response: ApproveResult }>(
        `SELECT response FROM wallet.idempotency_keys WHERE idem_key = $1 AND consumer_ref = $2`,
        [input.idempotencyKey, input.consumerRef],
      );
      if (replay.rows[0]) return replay.rows[0].response;
    }

    const result = await this.approveOnce(input);
    if (input.idempotencyKey) {
      await this.deps.pool.query(
        `INSERT INTO wallet.idempotency_keys (idem_key, consumer_ref, quote_id, response)
         VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (idem_key) DO NOTHING`,
        [input.idempotencyKey, input.consumerRef, input.quoteId, JSON.stringify(result)],
      );
    }
    return result;
  }

  private async approveOnce(input: {
    consumerRef: string;
    quoteId: string;
    mandateId: string;
  }): Promise<ApproveResult> {
    const quote = await this.deps.quotes.getQuote(input.quoteId);
    if (!quote) return { outcome: 'QUOTE_NOT_FOUND' };
    // quote liveness: approval after quote expiry → APPROVAL_EXPIRED (§6.4)
    if (Date.parse(quote.expires_at) <= this.deps.clock.now().getTime()) {
      return { outcome: 'APPROVAL_EXPIRED' };
    }

    const authorised = await this.deps.mandates.approveExplicitForQuote({
      consumerRef: input.consumerRef,
      mandateId: input.mandateId,
      quoteId: quote.quote_id,
      orderValue: quote.final,
      quoteExpiresAt: quote.expires_at, // Approval.exp = quote.expires_at
    });
    if (authorised.outcome !== 'approved' && authorised.outcome !== 'pre_authorised') {
      return { outcome: authorised.outcome };
    }
    const approval = authorised.approval;

    // re-mint (§6.4/§7.2): same qid, fresh jti, apr set — the original token
    // may have aged; only one token per qid ever converts (SYN-9).
    if (!quote.agent_id) return { outcome: 'REMINT_FAILED' }; // no agent to carry it
    const minted = await this.deps.reMint({
      cid: quote.commitment_id,
      qid: quote.quote_id,
      aid: quote.agent_id,
      tier: quote.tier,
      session_nonce: approval.approval_id, // fresh, approval-scoped
      apr: approval.approval_id,
      quote: { expires_at: quote.expires_at, mandate_ref: input.mandateId },
    } as MintRequest);
    if (!minted) return { outcome: 'REMINT_FAILED' };

    return {
      outcome: 'approved',
      approval,
      token: minted.token,
      token_expires_at: new Date(minted.claims.exp * 1000).toISOString(),
    };
  }

  /** Decline: `ApprovalDeclined` into the ledger; any errand awaiting this
   * quote expires gracefully (§6.4). Idempotent — declining twice is a no-op
   * second time round (the event is emitted once per quote). */
  async decline(input: {
    consumerRef: string;
    quoteId: string;
    mandateId: string;
  }): Promise<{ declined: boolean }> {
    // SECURITY — the caller may decline ONLY their own quote. Without this an
    // authenticated consumer who learns another's quote_id could write a
    // spurious ApprovalDeclined into the ledger and, via the global
    // idempotency guard below, short-circuit the owner's later decline. Once
    // ownership is enforced, only the owning consumer can ever write for a
    // given (globally-unique) quote_id, so the guard stays keyed on quote_id.
    const quote = await this.deps.quotes.getQuote(input.quoteId);
    if (!quote || quote.consumer_ref !== input.consumerRef) return { declined: false };

    const already = await this.deps.pool.query(
      `SELECT 1 FROM events.events
        WHERE type = 'ApprovalDeclined' AND body->'data'->>'quote_id' = $1`,
      [input.quoteId],
    );
    if ((already.rowCount ?? 0) > 0) return { declined: false };

    await appendEventInNewTx(this.deps.pool, 'ApprovalDeclined', {
      quote_id: input.quoteId,
      mandate_id: input.mandateId,
      declined_at: this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    // graceful errand expiry: any errand waiting on this quote stops waiting
    await this.deps.pool.query(
      `UPDATE wallet.errands SET state = 'EXPIRED', updated_at = now()
        WHERE consumer_ref = $1 AND brief->>'quote_id' = $2 AND state NOT IN ('CONFIRMED', 'FAILED', 'DECLINED', 'EXPIRED')`,
      [input.consumerRef, input.quoteId],
    );
    return { declined: true };
  }
}
