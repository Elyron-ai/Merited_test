import {
  Commitment,
  NettingRunRequest,
  NettingRunResult,
  ReverseRequest,
  type Position,
  type RejectionReasonCode,
  type ReverseResponse,
  type SettlementService,
  type Statement,
} from '@merited/contracts';
import { appendEvent } from '@merited/events';
import { monotonicFactory } from 'ulidx';
import { inTx, merchantKeyRef, type TrioDeps } from '../shared/deps.js';
import { claimSignaturePayload } from '../verification/verify-pipeline.js';
import { freeConversionCap, loadEntrySet, reversalEntrySet, storeEntrySet } from './posting.js';
import { buildStatement, foldPositions, livePosition, periodBounds } from './statements.js';

const ulid = monotonicFactory();

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

  async position(party: string): Promise<Position> {
    return livePosition(this.deps.pool, party);
  }

  /**
   * TRIO-11: fold every un-netted entry set into per-party net positions.
   * The `netted_sets` PK claims sets atomically — a set folds into exactly
   * one run ever, and concurrent runs partition the un-netted population
   * rather than double-counting it. Entries are never edited (append-only
   * marker), so a later reversal lands in the open period by construction.
   */
  async runNetting(requestInput: NettingRunRequest): Promise<NettingRunResult> {
    const request = NettingRunRequest.parse(requestInput);
    periodBounds(request.period); // 400 INVALID_PERIOD on a malformed period
    const runId = `net_${ulid()}`;
    return inTx(this.deps.pool, async (tx) => {
      await tx.query('INSERT INTO trio.netting_runs (netting_run_id, period) VALUES ($1, $2)', [
        runId,
        request.period,
      ]);
      const claimed = await tx.query<{ entry_set_id: string }>(
        `INSERT INTO trio.netted_sets (entry_set_id, netting_run_id)
         SELECT es.entry_set_id, $1
           FROM trio.entry_sets es
          WHERE NOT EXISTS (SELECT 1 FROM trio.netted_sets ns WHERE ns.entry_set_id = es.entry_set_id)
         ON CONFLICT DO NOTHING
         RETURNING entry_set_id`,
        [runId],
      );
      const setIds = claimed.rows.map((r) => r.entry_set_id);
      const folded = setIds.length
        ? await tx.query<{ account: string; signed: string }>(
            `SELECT account,
                    SUM(CASE WHEN side = 'cr' THEN amount_pence ELSE -amount_pence END) AS signed
               FROM trio.entry_lines
              WHERE entry_set_id = ANY($1::text[])
              GROUP BY account`,
            [setIds],
          )
        : { rows: [] };
      const positions = foldPositions(
        folded.rows.map((r) => ({ account: r.account, signed: Number(r.signed) })),
      );
      await appendEvent(tx, 'SettlementNetted', {
        netting_run_id: runId,
        period: request.period,
        positions,
      });
      return NettingRunResult.parse({ netting_run_id: runId, period: request.period, positions });
    });
  }

  async statement(party: string, period: string): Promise<Statement> {
    return buildStatement(this.deps.pool, party, period);
  }

  private now(): string {
    return this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}
