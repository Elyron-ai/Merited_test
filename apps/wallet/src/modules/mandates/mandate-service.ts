import {
  Approval,
  Mandate,
  newId,
  type MandateAttenuateRequest,
  type MandateGrantRequest,
  type Money,
} from '@merited/contracts';
import { appendEventInNewTx, canonicalJson } from '@merited/events';
import type { Signer } from '@merited/signing';
import type pg from 'pg';
import { attenuationViolations, MandateWideningError } from './attenuation.js';

/**
 * Consent & Mandate service (PH1-16, B14 — HIGH-SCRUTINY consent path).
 *
 *   grant → the consumer's authority to an agent, attestation signed via the
 *     platform Signer (consumer-held keys are out of scope in Ph 1), emits
 *     `MandateGranted`
 *   attenuate → a narrower CHILD referencing its parent; WIDENING IS REJECTED
 *     by construction (`attenuationViolations`), emits `MandateGranted`
 *   revoke → status flipped LIVE, emits `MandateRevoked`; the checkout gate
 *     reads status live, never cached
 *   authoriseForQuote → the wallet-path `checkout:execute` gate: a quote at or
 *     below `pre_authorised_up_to` records an IMPLICIT approval (nothing
 *     transacts without an approval object); above it, an explicit approval
 *     must already exist or the outcome is `APPROVAL_MISSING`
 */
const ATTEST_KEY = 'platform/attestations';

/**
 * Attestation payload = canonical JSON of the record minus its attestation
 * field — the EXACT convention the trio's `VerifiedDirectory` verifies before
 * trusting any approval/mandate at claim time (apps/trio directory.ts, P3:
 * never trust monolith input unverified). Datetimes are normalised to
 * `Date.toISOString()` before signing AND storing, so a record read back from
 * timestamptz columns re-verifies byte-for-byte.
 */
const attestationPayload = (record: Record<string, unknown>): string => {
  const { attestation: _a, ...rest } = record;
  return canonicalJson(rest);
};

export type AuthoriseResult =
  | { outcome: 'pre_authorised'; approval: Approval }
  | { outcome: 'approved'; approval: Approval }
  | { outcome: 'APPROVAL_MISSING' }
  | { outcome: 'MANDATE_REVOKED' }
  | { outcome: 'LIMIT_EXCEEDED' }
  | { outcome: 'CHECKOUT_SCOPE_MISSING' };

export interface MandateServiceDeps {
  pool: pg.Pool;
  signer: Signer;
  clock: { now(): Date };
}

export class MandateService {
  constructor(private readonly deps: MandateServiceDeps) {}

  async grant(input: { consumerRef: string; request: MandateGrantRequest }): Promise<Mandate> {
    const draft = {
      mandate_id: newId('mnd'),
      consumer_ref: input.consumerRef,
      ...input.request,
      exp: new Date(input.request.exp).toISOString(),
      status: 'active' as const,
    };
    const attestation = await this.deps.signer.sign(ATTEST_KEY, attestationPayload(draft));
    const mandate = Mandate.parse({ ...draft, attestation });
    await this.insert(mandate, null);
    await appendEventInNewTx(this.deps.pool, 'MandateGranted', { mandate });
    return mandate;
  }

  /**
   * Attenuate: build a child by overlaying the (narrowing) patch on the parent,
   * then REJECT if it widens any dimension. The check is by construction — an
   * escalation can never be persisted.
   */
  async attenuate(input: {
    consumerRef: string;
    parentId: string;
    patch: MandateAttenuateRequest;
  }): Promise<Mandate> {
    const parent = await this.get(input.parentId);
    if (!parent || parent.consumer_ref !== input.consumerRef) throw new Error('parent mandate not found');
    if (parent.status !== 'active') throw new Error('cannot attenuate a non-active mandate');

    const childDraft = {
      mandate_id: newId('mnd'),
      consumer_ref: input.consumerRef,
      agent_id: parent.agent_id,
      scopes: input.patch.scopes ?? parent.scopes,
      limits: {
        per_txn: input.patch.limits?.per_txn ?? parent.limits.per_txn,
        per_month: input.patch.limits?.per_month ?? parent.limits.per_month,
        categories: input.patch.limits?.categories ?? parent.limits.categories,
      },
      merchants: input.patch.merchants ?? parent.merchants,
      data_sharing: {
        email: input.patch.data_sharing?.email ?? parent.data_sharing.email,
        purchase_history: input.patch.data_sharing?.purchase_history ?? parent.data_sharing.purchase_history,
        loyalty_ids: input.patch.data_sharing?.loyalty_ids ?? parent.data_sharing.loyalty_ids,
      },
      pre_authorised_up_to: input.patch.pre_authorised_up_to ?? parent.pre_authorised_up_to,
      status: 'active' as const,
      exp: new Date(input.patch.exp ?? parent.exp).toISOString(),
    };
    const attestation = await this.deps.signer.sign(ATTEST_KEY, attestationPayload(childDraft));
    const child = Mandate.parse({ ...childDraft, attestation });

    const violations = attenuationViolations(parent, child);
    if (violations.length > 0) throw new MandateWideningError(violations);

    await this.insert(child, parent.mandate_id);
    await appendEventInNewTx(this.deps.pool, 'MandateGranted', { mandate: child });
    return child;
  }

  /** Revoke LIVE — the next status read (eligibility, checkout:execute) sees
   * 'revoked'. Idempotent: a second revoke is a no-op. Scoped to the owning
   * consumer (SECURITY): a mandate_id is a non-secret ULID that circulates as
   * `mandate_ref`, so without the consumer_ref predicate any authenticated
   * wallet session could revoke another consumer's mandate (IDOR) and instantly
   * strip that consumer's agent of checkout authority. */
  async revoke(input: { mandateId: string; consumerRef: string }): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ consumer_ref: string }>(
      `UPDATE wallet.mandates SET status = 'revoked'
        WHERE mandate_id = $1 AND consumer_ref = $2 AND status = 'active'
      RETURNING consumer_ref`,
      [input.mandateId, input.consumerRef],
    );
    const row = rows[0];
    if (!row) return false;
    await appendEventInNewTx(this.deps.pool, 'MandateRevoked', {
      mandate_id: input.mandateId,
      consumer_ref: row.consumer_ref,
      revoked_at: this.nowIso(),
    });
    return true;
  }

  /**
   * The wallet-path `checkout:execute` gate (§6.1). Reads mandate status LIVE
   * so a mid-session revocation fails the very next attempt with
   * `MANDATE_REVOKED`. A quote at/below `pre_authorised_up_to` records an
   * implicit approval; above it, an explicit approval (PH1-18) must exist.
   */
  async authoriseForQuote(input: {
    mandateId: string;
    quoteId: string;
    orderValue: Money;
    quoteExpiresAt: string;
  }): Promise<AuthoriseResult> {
    const mandate = await this.get(input.mandateId);
    if (!mandate || mandate.status !== 'active') return { outcome: 'MANDATE_REVOKED' };
    if (Date.parse(mandate.exp) <= this.deps.clock.now().getTime()) return { outcome: 'MANDATE_REVOKED' };
    if (!mandate.scopes.includes('checkout:execute')) return { outcome: 'CHECKOUT_SCOPE_MISSING' };
    if (input.orderValue.amount > mandate.limits.per_txn.amount) return { outcome: 'LIMIT_EXCEEDED' };

    const existing = await this.approvalFor(input.quoteId);
    if (input.orderValue.amount <= mandate.pre_authorised_up_to.amount) {
      if (existing) {
        return { outcome: existing.mode === 'pre_authorised' ? 'pre_authorised' : 'approved', approval: existing };
      }
      const approval = await this.recordApproval(mandate, input.quoteId, 'pre_authorised', input.quoteExpiresAt);
      return { outcome: 'pre_authorised', approval };
    }
    // above the pre-authorised threshold: needs an explicit approval (PH1-18)
    if (existing && existing.mode === 'explicit') return { outcome: 'approved', approval: existing };
    return { outcome: 'APPROVAL_MISSING' };
  }

  /**
   * Issue an EXPLICIT approval (PH1-18, §6.4) — the consumer said yes on the
   * approval screen. Same live-status/limit checks as the checkout gate, same
   * `recordApproval` code path the pre_authorised branch uses (single-use per
   * quote, `ApprovalGranted` emitted once). `exp = quote.expires_at`.
   */
  async approveExplicitForQuote(input: {
    consumerRef: string;
    mandateId: string;
    quoteId: string;
    orderValue: Money;
    quoteExpiresAt: string;
  }): Promise<AuthoriseResult> {
    const mandate = await this.get(input.mandateId);
    if (!mandate || mandate.status !== 'active') return { outcome: 'MANDATE_REVOKED' };
    if (mandate.consumer_ref !== input.consumerRef) return { outcome: 'MANDATE_REVOKED' }; // not yours → no oracle
    if (Date.parse(mandate.exp) <= this.deps.clock.now().getTime()) return { outcome: 'MANDATE_REVOKED' };
    if (!mandate.scopes.includes('checkout:execute')) return { outcome: 'CHECKOUT_SCOPE_MISSING' };
    if (input.orderValue.amount > mandate.limits.per_txn.amount) return { outcome: 'LIMIT_EXCEEDED' };

    const existing = await this.approvalFor(input.quoteId);
    if (existing) {
      return { outcome: existing.mode === 'pre_authorised' ? 'pre_authorised' : 'approved', approval: existing };
    }
    const approval = await this.recordApproval(mandate, input.quoteId, 'explicit', input.quoteExpiresAt);
    return { outcome: 'approved', approval };
  }

  async get(mandateId: string): Promise<Mandate | null> {
    const { rows } = await this.deps.pool.query<MandateRow>(
      `SELECT mandate_id, consumer_ref, agent_id, scopes, limits, merchants, data_sharing,
              pre_authorised_up_to, status, exp, attestation
         FROM wallet.mandates WHERE mandate_id = $1`,
      [mandateId],
    );
    const r = rows[0];
    if (!r) return null;
    return Mandate.parse({
      mandate_id: r.mandate_id,
      consumer_ref: r.consumer_ref,
      agent_id: r.agent_id,
      scopes: r.scopes,
      limits: r.limits,
      merchants: r.merchants,
      data_sharing: r.data_sharing,
      pre_authorised_up_to: r.pre_authorised_up_to,
      status: r.status,
      exp: new Date(r.exp).toISOString(),
      attestation: r.attestation,
    });
  }

  private async recordApproval(
    mandate: Mandate,
    quoteId: string,
    mode: 'explicit' | 'pre_authorised',
    exp: string,
  ): Promise<Approval> {
    const draft = {
      approval_id: newId('apr'),
      mandate_id: mandate.mandate_id,
      quote_id: quoteId,
      mode,
      approved_at: this.deps.clock.now().toISOString(),
      exp: new Date(exp).toISOString(), // = quote.expires_at, normalised
    };
    const attestation = await this.deps.signer.sign(ATTEST_KEY, attestationPayload(draft));
    const approval = Approval.parse({ ...draft, attestation });
    // single-use per quote (UNIQUE quote_id); a race loses here and re-reads
    const inserted = await this.deps.pool.query(
      `INSERT INTO wallet.approvals (approval_id, mandate_id, quote_id, mode, approved_at, exp, attestation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (quote_id) DO NOTHING`,
      [approval.approval_id, approval.mandate_id, approval.quote_id, approval.mode, approval.approved_at, approval.exp, approval.attestation],
    );
    if (inserted.rowCount === 0) {
      return (await this.approvalFor(quoteId))!; // another writer won — use theirs
    }
    await appendEventInNewTx(this.deps.pool, 'ApprovalGranted', { approval });
    return approval;
  }

  /**
   * TRIO-17: the record served to the trio's directory lookup, re-attested
   * over its CURRENT state. A revoked mandate's stored attestation covers
   * the 'active' state it was granted with — re-signing on read lets the
   * trio VERIFY the record and then see `status: 'revoked'` for itself
   * (live check, no cache window), instead of treating an unverifiable
   * blob as merely absent.
   */
  async attestedCurrent(mandateId: string): Promise<Mandate | null> {
    const stored = await this.get(mandateId);
    if (!stored) return null;
    const { attestation: _stale, ...current } = stored;
    const attestation = await this.deps.signer.sign(ATTEST_KEY, attestationPayload(current));
    return Mandate.parse({ ...current, attestation });
  }

  /** TRIO-17: directory lookup by approval id (the token's `apr` claim). */
  async approvalById(approvalId: string): Promise<Approval | null> {
    const { rows } = await this.deps.pool.query<ApprovalRow>(
      `SELECT approval_id, mandate_id, quote_id, mode, approved_at, exp, attestation
         FROM wallet.approvals WHERE approval_id = $1`,
      [approvalId],
    );
    const r = rows[0];
    if (!r) return null;
    return Approval.parse({
      approval_id: r.approval_id,
      mandate_id: r.mandate_id,
      quote_id: r.quote_id,
      mode: r.mode,
      approved_at: new Date(r.approved_at).toISOString(),
      exp: new Date(r.exp).toISOString(),
      attestation: r.attestation,
    });
  }

  async approvalFor(quoteId: string): Promise<Approval | null> {
    const { rows } = await this.deps.pool.query<ApprovalRow>(
      `SELECT approval_id, mandate_id, quote_id, mode, approved_at, exp, attestation
         FROM wallet.approvals WHERE quote_id = $1`,
      [quoteId],
    );
    const r = rows[0];
    if (!r) return null;
    return Approval.parse({
      approval_id: r.approval_id,
      mandate_id: r.mandate_id,
      quote_id: r.quote_id,
      mode: r.mode,
      approved_at: new Date(r.approved_at).toISOString(),
      exp: new Date(r.exp).toISOString(),
      attestation: r.attestation,
    });
  }

  private async insert(mandate: Mandate, parentId: string | null): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO wallet.mandates
         (mandate_id, consumer_ref, agent_id, parent_id, scopes, limits, merchants,
          data_sharing, pre_authorised_up_to, status, exp, attestation)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)`,
      [
        mandate.mandate_id,
        mandate.consumer_ref,
        mandate.agent_id,
        parentId,
        JSON.stringify(mandate.scopes),
        JSON.stringify(mandate.limits),
        JSON.stringify(mandate.merchants),
        JSON.stringify(mandate.data_sharing),
        JSON.stringify(mandate.pre_authorised_up_to),
        mandate.status,
        mandate.exp,
        mandate.attestation,
      ],
    );
  }

  private nowIso(): string {
    return this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

interface MandateRow {
  mandate_id: string;
  consumer_ref: string;
  agent_id: string;
  scopes: Mandate['scopes'];
  limits: Mandate['limits'];
  merchants: string[];
  data_sharing: Mandate['data_sharing'];
  pre_authorised_up_to: Money;
  status: Mandate['status'];
  exp: Date;
  attestation: string;
}

interface ApprovalRow {
  approval_id: string;
  mandate_id: string;
  quote_id: string;
  mode: Approval['mode'];
  approved_at: Date;
  exp: Date;
  attestation: string;
}
