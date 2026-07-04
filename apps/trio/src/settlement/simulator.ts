import {
  Commitment,
  ReverseRequest,
  type NettingRunRequest,
  type NettingRunResult,
  type Position,
  type RejectionReasonCode,
  type ReverseResponse,
  type SettlementService,
  type Statement,
} from '@merited/contracts';
import { appendEvent } from '@merited/events';
import { inTx, merchantKeyRef, TrioHttpError, type TrioDeps } from '../shared/deps.js';
import { claimSignaturePayload } from '../verification/verify-pipeline.js';
import { freeConversionCap, loadEntrySet, reversalEntrySet, storeEntrySet } from './posting.js';

interface ConsumedRow {
  jti: string;
  cid: string;
  consumed_at: Date;
}

/**
 * Settlement SIMULATOR (TRIO-10/11, §7.3) — real arithmetic throughout
 * (spec §7.3: "it's accounting, not crypto"), all of it living in the
 * retained `posting.ts`. The ONLY simulated part is merchant-signature
 * verification via FakeSigner; PH1-26 swaps this file for one that verifies
 * real Ed25519 signatures and keeps everything else byte-identical.
 *
 * Clawback (SYN-10): a `ConversionReversed` claim is accepted only while
 * `clock.now() ≤ consumed_at + clawback_window_s`; after-window reuses
 * `WINDOW_EXPIRED` (the §3 reason-code enum stays closed). A reversal frees
 * the `max_conversions` counter only. SYN-35: double-reverse reuses
 * `TOKEN_REPLAYED`; an unknown claim or a merchant mismatch reuses
 * `SIG_INVALID` (the trio's own records are authoritative — absent means
 * the input is not trusted, the same pattern as verify stage 1).
 */
export class SettlementSimulator implements SettlementService {
  constructor(private readonly deps: TrioDeps) {}

  async reverse(requestInput: ReverseRequest): Promise<ReverseResponse> {
    const request = ReverseRequest.parse(requestInput);
    const reject = (reason: RejectionReasonCode): ReverseResponse => ({
      verdict: 'rejected',
      reason_code: reason,
    });

    // ── signature first (mirror of verify stage 1) ──────────────────────────
    const sigOk = await this.deps.signer.verify(
      merchantKeyRef(request.merchant_id),
      claimSignaturePayload(request),
      request.merchant_sig,
    );
    if (!sigOk) return reject('SIG_INVALID');

    // ── the trio's own records are authoritative (SYN-8 pattern, SYN-35) ───
    const consumed = await this.deps.pool.query<ConsumedRow>(
      `SELECT cj.jti, mt.cid, cj.consumed_at
         FROM trio.consumed_jtis cj
         JOIN trio.minted_tokens mt ON mt.jti = cj.jti
        WHERE cj.claim_id = $1
        LIMIT 1`,
      [request.claim_id],
    );
    if (consumed.rows.length === 0) return reject('SIG_INVALID');
    const conversion = consumed.rows[0]!;

    const corRows = await this.deps.pool.query<{ body: unknown }>(
      'SELECT body FROM trio.commitments WHERE commitment_id = $1',
      [conversion.cid],
    );
    if (corRows.rows.length === 0) return reject('SIG_INVALID');
    const cor = Commitment.parse(corRows.rows[0]!.body);
    if (cor.merchant_id !== request.merchant_id) return reject('SIG_INVALID');

    // ── double-reverse (SYN-35: a reversal replay reuses TOKEN_REPLAYED) ───
    const reversalId = `set_rev_${request.claim_id}`;
    const already = await this.deps.pool.query(
      'SELECT 1 FROM trio.entry_sets WHERE entry_set_id = $1',
      [reversalId],
    );
    if (already.rows.length > 0) return reject('TOKEN_REPLAYED');

    // ── clawback window (SYN-10: reuses WINDOW_EXPIRED, distinct trigger) ──
    const deadlineMs = conversion.consumed_at.getTime() + cor.terms.clawback_window_s * 1000;
    if (this.deps.clock.now().getTime() > deadlineMs) return reject('WINDOW_EXPIRED');

    const original = await loadEntrySet(this.deps.pool, `set_${request.claim_id}`);
    if (!original) return reject('SIG_INVALID'); // consumed but never posted: not a trusted record

    // ── post: reversing set + freed cap + event, one transaction ───────────
    const entries = reversalEntrySet(original);
    try {
      return await inTx(this.deps.pool, async (tx) => {
        await storeEntrySet(tx, entries);
        await freeConversionCap(tx, conversion.cid);
        await appendEvent(tx, 'ConversionReversed', {
          claim_id: request.claim_id,
          merchant_id: request.merchant_id,
          reversed_at: this.now(),
          ...(request.reason ? { reason: request.reason } : {}),
        });
        return { verdict: 'reversed', entries_preview: entries };
      });
    } catch (error) {
      // Concurrent double-reverse: the entry_sets PK is the arbiter — the
      // loser's transaction rolls back whole (no entries, no counter change).
      if ((error as { code?: string }).code === '23505') return reject('TOKEN_REPLAYED');
      throw error;
    }
  }

  async position(_party: string): Promise<Position> {
    throw new TrioHttpError(501, 'NOT_IMPLEMENTED', 'positions land with TRIO-11');
  }

  async runNetting(_request: NettingRunRequest): Promise<NettingRunResult> {
    throw new TrioHttpError(501, 'NOT_IMPLEMENTED', 'netting lands with TRIO-11');
  }

  async statement(_party: string, _period: string): Promise<Statement> {
    throw new TrioHttpError(501, 'NOT_IMPLEMENTED', 'statements land with TRIO-11');
  }

  private now(): string {
    return this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}
