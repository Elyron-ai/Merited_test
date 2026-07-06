import {
  Commitment,
  VerifyRequest,
  type Approval,
  type Mandate,
  type RejectionReasonCode,
  type VerifyResponse,
} from '@merited/contracts';
import { appendEvent, canonicalJson, sha256hex } from '@merited/events';
import {
  merchantSignedPayload,
  unsignedCommitmentPayload,
} from '../commitment/simulator.js';
import type { ReplayCache } from '@merited/contracts';
import {
  inTx,
  merchantKeyRef,
  TrioHttpError,
  type TrioDeps,
} from '../shared/deps.js';
import { codecFor, type TokenCodec } from './token-codec.js';
import type { TrioDirectory } from '../shared/ports/directory.js';
import {
  applyConversionCounters,
  bountyFor,
  conversionEntrySet,
  lockAndCheckCounters,
  mandateMonthSpend,
  monthKey,
  recordMandateSpend,
  storeEntrySet,
} from '../settlement/posting.js';
import { consumeToken, isConsumed } from './replay-store.js';

/** Merchant signature payload for a claim (used by MER-4 and the tests). */
export const claimSignaturePayload = (claim: Record<string, unknown>): string => {
  const { merchant_sig: _m, ...rest } = claim;
  return canonicalJson(rest);
};

interface MintedRow {
  jti: string;
  cid: string;
  qid: string;
  aid: string;
  tier: string;
  iat: number;
  exp: number;
  quote_expires_at: string;
  mandate_ref: string | null;
  apr: string | null;
}

type Rejection = { verdict: 'rejected'; reason: RejectionReasonCode; jti?: string };

/**
 * W10/#28: thrown inside the verdict transaction when a CONCURRENT same-key
 * verify has already stored its verdict. It aborts (rolls back) this request's
 * transaction — so any events it wrote are discarded — and the caller converges
 * on the winner's stored verdict instead of 500-ing on the idempotency PK.
 */
class IdempotencyRaceLost extends Error {}

/**
 * Conversion Verification SIMULATOR (TRIO-8, §7.2) — the six-stage pipeline
 * in the spec's exact order, first-failure-wins. Fake signature primitives
 * (FakeSigner) are the ONLY simulated part; replay, window, quote, terms and
 * approval logic are real and retained (PH1-25 swaps the crypto, not this
 * ordering). `ConversionClaimed` is emitted upstream by the adapter (SYN-6).
 *
 * SYN-34: ending a commitment stops NEW mints, not in-flight tokens (§5.1 /
 * arch §2.2 "no retroactive repricing"). Stage 5's COMMITMENT_ENDED fires
 * when the claim's order.ts falls outside the COR's own validity window.
 *
 * The trio trusts ONLY its own records for token facts: claims fields are
 * cross-checked against the minted_tokens row (SYN-8); directory records are
 * attestation-verified (TRIO-7).
 */
export class VerifySimulator {
  private readonly codec: TokenCodec;

  constructor(
    private readonly deps: TrioDeps,
    private readonly directory: TrioDirectory,
    /** PH1-25: Redis fast-path for stage 2 — NEVER authoritative for a
     * verified verdict (Postgres consumption inside the verdict tx is);
     * a cache hit only short-circuits to the SAFE outcome (reject). */
    private readonly replayCache?: ReplayCache,
  ) {
    this.codec = codecFor(deps.signer);
  }

  async verify(
    claimInput: VerifyRequest,
    options: { idempotencyKey: string },
  ): Promise<VerifyResponse> {
    if (!options.idempotencyKey) throw new TrioHttpError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const claim = VerifyRequest.parse(claimInput);
    const requestHash = sha256hex(canonicalJson(claim));

    // §8 idempotency: same key + same body → stored original, byte-identical.
    const existing = await this.deps.pool.query<{ request_hash: string; response: VerifyResponse }>(
      `SELECT request_hash, response FROM trio.idempotency_keys WHERE scope = 'claims/verify' AND key = $1`,
      [options.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      if (row.request_hash !== requestHash) throw new TrioHttpError(422, 'IDEMPOTENCY_CONFLICT');
      return row.response;
    }

    const outcome = await this.pipeline(claim);

    let settled: VerifyResponse;
    try {
      settled = await inTx(this.deps.pool, async (tx) => {
      // W10/#28: store the verdict under the idempotency key WITHIN the verdict
      // transaction. ON CONFLICT DO NOTHING → a concurrent winner already stored
      // it → abort so this request's events roll back and we converge on theirs
      // (previously a bare INSERT hit the PK and 500'd, and would have committed
      // a spurious event alongside the winner's).
      const storeVerdict = async (r: VerifyResponse): Promise<void> => {
        const ins = await tx.query(
          `INSERT INTO trio.idempotency_keys (scope, key, request_hash, response)
             VALUES ('claims/verify', $1, $2, $3::jsonb)
             ON CONFLICT (scope, key) DO NOTHING`,
          [options.idempotencyKey, requestHash, canonicalJson(r)],
        );
        if ((ins.rowCount ?? 0) === 0) throw new IdempotencyRaceLost();
      };
      let response: VerifyResponse;
      if (outcome.verdict === 'verified') {
        // PH1-26: lock + re-check the commitment counters FIRST — the row
        // lock serialises concurrent claims on one commitment, so a cap or
        // budget can never double-spend (stage 5's read was a fast path).
        // Nothing is written on refusal: the token is not burnt (SYN-9).
        const counters = await lockAndCheckCounters(
          tx,
          outcome.minted.cid,
          outcome.bounty,
          outcome.maxConversions,
        );
        if (!counters.ok) {
          response = { verdict: 'rejected', reason_code: counters.reason };
          await appendEvent(tx, 'ConversionRejected', {
            claim_id: claim.claim_id,
            merchant_id: claim.merchant_id,
            jti: outcome.minted.jti,
            reason_code: counters.reason,
            rejected_at: this.now(),
          });
          await storeVerdict(response);
          return response;
        }
        // Consume + post + counters in ONE transaction with the verdict.
        const consumption = await consumeToken(tx, {
          jti: outcome.minted.jti,
          qid: outcome.minted.qid,
          claim_id: claim.claim_id,
        });
        if (!consumption.consumed) {
          response = { verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' };
          await appendEvent(tx, 'ConversionRejected', {
            claim_id: claim.claim_id,
            merchant_id: claim.merchant_id,
            jti: outcome.minted.jti,
            reason_code: 'TOKEN_REPLAYED',
            rejected_at: this.now(),
          });
        } else {
          await storeEntrySet(tx, outcome.entries);
          await applyConversionCounters(tx, outcome.minted.cid, outcome.bounty);
          if (outcome.minted.mandate_ref) {
            await recordMandateSpend(
              tx,
              outcome.minted.mandate_ref,
              monthKey(new Date(claim.order.ts)),
              claim.order.gross_value.amount,
            );
          }
          await appendEvent(tx, 'ConversionVerified', {
            claim_id: claim.claim_id,
            merchant_id: claim.merchant_id,
            jti: outcome.minted.jti,
            qid: outcome.minted.qid,
            cid: outcome.minted.cid,
            gross_value: claim.order.gross_value,
            verified_at: this.now(),
          });
          response = { verdict: 'verified', entries_preview: outcome.entries };
        }
      } else {
        response = { verdict: 'rejected', reason_code: outcome.reason };
        await appendEvent(tx, 'ConversionRejected', {
          claim_id: claim.claim_id,
          merchant_id: claim.merchant_id,
          jti: outcome.jti ?? null,
          reason_code: outcome.reason,
          rejected_at: this.now(),
        });
      }
      await storeVerdict(response);
      return response;
      });
    } catch (error) {
      // W10/#28: a concurrent same-key verify won the idempotency race — our
      // transaction rolled back (no duplicate/spurious events), so return the
      // winner's stored verdict verbatim instead of surfacing a 500.
      if (error instanceof IdempotencyRaceLost) {
        const stored = await this.deps.pool.query<{ request_hash: string; response: VerifyResponse }>(
          `SELECT request_hash, response FROM trio.idempotency_keys WHERE scope = 'claims/verify' AND key = $1`,
          [options.idempotencyKey],
        );
        const row = stored.rows[0];
        if (!row) throw error; // winner's row vanished — genuinely exceptional
        if (row.request_hash !== requestHash) throw new TrioHttpError(422, 'IDEMPOTENCY_CONFLICT');
        return row.response;
      }
      throw error;
    }

    // cache mark AFTER commit; failures ignored — Redis is never a source of
    // truth and never blocks a verdict. Only the winner reaches here for a key.
    if (settled.verdict === 'verified' && outcome.verdict === 'verified' && this.replayCache) {
      const ttl = 2 * 24 * 3600; // covers the attribution window comfortably
      await this.replayCache.seenBefore(`jti:${outcome.minted.jti}`, ttl).catch(() => {});
    }
    return settled;
  }

  private now(): string {
    return this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private async pipeline(
    claim: VerifyRequest,
  ): Promise<
    | {
        verdict: 'verified';
        minted: MintedRow;
        entries: ReturnType<typeof conversionEntrySet>;
        bounty: number;
        maxConversions: number | null;
      }
    | Rejection
  > {
    const reject = (reason: RejectionReasonCode, jti?: string): Rejection => ({
      verdict: 'rejected',
      reason,
      ...(jti ? { jti } : {}),
    });

    // ── stage 1: signature chain ────────────────────────────────────────────
    const merchantSigOk = await this.deps.signer.verify(
      merchantKeyRef(claim.merchant_id),
      claimSignaturePayload(claim),
      claim.merchant_sig,
    );
    if (!merchantSigOk) return reject('SIG_INVALID');

    // PH1-25: the codec owns the wire format — fake pseudo-tokens or real
    // PASETO v4.public by signer capability; null = fail closed.
    const claims = await this.codec.decode(claim.attribution_token);
    if (!claims) return reject('SIG_INVALID');

    // The trio's own mint record is authoritative (SYN-8) — absent = forged.
    const mintedRows = await this.deps.pool.query<MintedRow>(
      `SELECT jti, cid, qid, aid, tier, iat::int AS iat, exp::int AS exp,
              quote_expires_at, mandate_ref, apr
         FROM trio.minted_tokens WHERE jti = $1`,
      [claims.jti],
    );
    if (mintedRows.rows.length === 0) return reject('SIG_INVALID', claims.jti);
    const minted = mintedRows.rows[0]!;

    const corRows = await this.deps.pool.query<{ body: unknown }>(
      'SELECT body FROM trio.commitments WHERE commitment_id = $1',
      [minted.cid],
    );
    if (corRows.rows.length === 0) return reject('SIG_INVALID', minted.jti);
    const cor = Commitment.parse(corRows.rows[0]!.body);
    if (cor.merchant_id !== claim.merchant_id) return reject('SIG_INVALID', minted.jti);
    const corMerchantOk = await this.deps.signer.verify(
      merchantKeyRef(cor.merchant_id),
      unsignedCommitmentPayload(cor as never),
      cor.merchant_sig,
    );
    const corPlatformOk = await this.deps.signer.verify(
      'platform/commitments',
      merchantSignedPayload(cor as never),
      cor.platform_sig,
    );
    if (!corMerchantOk || !corPlatformOk) return reject('SIG_INVALID', minted.jti);

    const orderTs = Math.floor(Date.parse(claim.order.ts) / 1000);

    // ── stage 2: replay (read check; consumption happens with the verdict) ──
    // Fast path (PH1-25): a cache hit rejects without touching Postgres —
    // the safe direction only; verified verdicts always go through the
    // authoritative consumption transaction.
    if (this.replayCache && (await this.replayCache.peek(`jti:${minted.jti}`))) {
      return reject('TOKEN_REPLAYED', minted.jti);
    }
    const client = await this.deps.pool.connect();
    try {
      if (await isConsumed(client, minted.jti)) return reject('TOKEN_REPLAYED', minted.jti);
    } finally {
      client.release();
    }

    // ── stage 3: attribution window ─────────────────────────────────────────
    if (orderTs < minted.iat || orderTs > minted.iat + cor.terms.attribution_window_s) {
      return reject('WINDOW_EXPIRED', minted.jti);
    }

    // ── stage 4: quote liveness (trio's own snapshot — SYN-8) ───────────────
    if (orderTs > Math.floor(Date.parse(minted.quote_expires_at) / 1000)) {
      return reject('QUOTE_EXPIRED', minted.jti);
    }

    // ── stage 5: commitment terms ───────────────────────────────────────────
    // SYN-34: /end stops new mints, not in-flight tokens. Validity window is
    // the COR's own promise boundary.
    if (
      orderTs < Math.floor(Date.parse(cor.terms.valid_from) / 1000) ||
      orderTs > Math.floor(Date.parse(cor.terms.valid_until) / 1000)
    ) {
      return reject('COMMITMENT_ENDED', minted.jti);
    }
    const counters = await this.deps.pool.query<{
      conversions_used: number;
      budget_remaining_pence: string | null;
    }>('SELECT conversions_used, budget_remaining_pence FROM trio.counters WHERE commitment_id = $1', [
      minted.cid,
    ]);
    const used = counters.rows[0]?.conversions_used ?? 0;
    if (cor.terms.max_conversions !== null && used >= cor.terms.max_conversions) {
      return reject('CAP_EXHAUSTED', minted.jti);
    }
    if (!cor.terms.eligible_identity_tiers.includes(minted.tier as never)) {
      return reject('TIER_INELIGIBLE', minted.jti);
    }
    const bounty = bountyFor(cor, claim.order.gross_value.amount);
    const budgetRemaining = counters.rows[0]?.budget_remaining_pence;
    if (budgetRemaining !== null && budgetRemaining !== undefined && Number(budgetRemaining) < bounty) {
      return reject('BUDGET_EXHAUSTED', minted.jti);
    }

    // ── stage 6: approval + mandate checks (wallet path only) ───────────────
    if (minted.apr === null && minted.mandate_ref !== null) {
      // SYN-8 wallet-path guard: quote was minted under a mandate but the
      // token carries no approval → execute-without-approval.
      return reject('APPROVAL_MISSING', minted.jti);
    }
    if (minted.apr !== null) {
      const approval: Approval | null = await this.directory.getApproval(minted.apr);
      if (!approval || approval.quote_id !== minted.qid) return reject('APPROVAL_MISSING', minted.jti);
      if (orderTs > Math.floor(Date.parse(approval.exp) / 1000)) {
        return reject('APPROVAL_EXPIRED', minted.jti);
      }
      const mandate: Mandate | null = await this.directory.getMandate(approval.mandate_id);
      if (!mandate || mandate.status !== 'active') return reject('MANDATE_REVOKED', minted.jti);
      if (claim.order.gross_value.amount > mandate.limits.per_txn.amount) {
        return reject('LIMIT_EXCEEDED', minted.jti);
      }
      const monthClient = await this.deps.pool.connect();
      try {
        const spent = await mandateMonthSpend(
          monthClient,
          mandate.mandate_id,
          monthKey(new Date(claim.order.ts)),
        );
        if (spent + claim.order.gross_value.amount > mandate.limits.per_month.amount) {
          return reject('LIMIT_EXCEEDED', minted.jti);
        }
      } finally {
        monthClient.release();
      }
    }

    const entries = conversionEntrySet({
      commitment: cor,
      agentId: minted.aid,
      claimId: claim.claim_id,
      grossPence: claim.order.gross_value.amount,
    });
    return { verdict: 'verified', minted, entries, bounty, maxConversions: cor.terms.max_conversions };
  }
}
