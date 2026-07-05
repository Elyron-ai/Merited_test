import {
  Commitment,
  CommitmentDraft,
  MerchantKeyRequest,
  MerchantKeySignRequest,
  newId,
  pence,
  type CommitmentCreateResponse,
  type CommitmentEndRequest,
  type CommitmentEndResponse,
  type CommitmentSigningService,
  type CommitmentStatus,
  type MerchantKeyResponse,
  type MerchantKeyService,
  type MerchantKeySignResponse,
} from '@merited/contracts';
import { appendEvent, canonicalJson } from '@merited/events';
import {
  inTx,
  merchantKeyRef,
  PLATFORM_COMMITMENT_KEY,
  TrioHttpError,
  type TrioDeps,
} from '../shared/deps.js';

/**
 * Commitment Signing SIMULATOR (TRIO-4, §7.1) — replaced file-for-file by
 * PH1-24 (real Ed25519 via the PH1-30 Signer). Behaviour is normative:
 * immutable CORs (no update path in code; DB role revokes UPDATE), fake
 * countersignatures, CommitmentCreated/CommitmentEnded into the hash chain
 * in the SAME transaction as the write.
 *
 * Signing payloads (shared with verification's signature-chain check):
 *   merchant_sig  over canonical_json(COR minus both sigs)
 *   platform_sig  over canonical_json(COR minus platform_sig, incl. merchant_sig)
 */
export const unsignedCommitmentPayload = (cor: Record<string, unknown>): string => {
  const { merchant_sig: _m, platform_sig: _p, ...rest } = cor;
  return canonicalJson(rest);
};
export const merchantSignedPayload = (cor: Record<string, unknown>): string => {
  const { platform_sig: _p, ...rest } = cor;
  return canonicalJson(rest);
};

export class CommitmentSimulator implements CommitmentSigningService {
  constructor(private readonly deps: TrioDeps) {}

  async create(draftInput: CommitmentDraft): Promise<CommitmentCreateResponse> {
    const draft = CommitmentDraft.parse(draftInput);
    const { budget, ...corFields } = draft;
    const base = { commitment_id: newId('com'), ...corFields };

    const merchant_sig = await this.deps.signer.sign(
      merchantKeyRef(draft.merchant_id),
      unsignedCommitmentPayload(base),
    );
    const platform_sig = await this.deps.signer.sign(
      PLATFORM_COMMITMENT_KEY,
      merchantSignedPayload({ ...base, merchant_sig }),
    );
    const commitment = Commitment.parse({ ...base, merchant_sig, platform_sig });

    await inTx(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO trio.commitments (commitment_id, merchant_id, offer_ref, body)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [commitment.commitment_id, commitment.merchant_id, commitment.offer_ref, canonicalJson(commitment)],
      );
      await tx.query(
        `INSERT INTO trio.counters (commitment_id, conversions_used, budget_remaining_pence)
         VALUES ($1, 0, $2)`,
        [commitment.commitment_id, budget?.amount ?? null],
      );
      await appendEvent(tx, 'CommitmentCreated', { commitment });
    });
    return { commitment };
  }

  async end(commitmentId: string, request: CommitmentEndRequest): Promise<CommitmentEndResponse> {
    const endedAt = this.deps.clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return inTx(this.deps.pool, async (tx) => {
      const found = await tx.query<{ merchant_id: string }>(
        'SELECT merchant_id FROM trio.commitments WHERE commitment_id = $1',
        [commitmentId],
      );
      if (found.rows.length === 0) throw new TrioHttpError(404, 'COMMITMENT_NOT_FOUND');
      const inserted = await tx.query(
        `INSERT INTO trio.commitment_terminations (commitment_id, ended_at, reason)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING commitment_id`,
        [commitmentId, endedAt, request.reason ?? null],
      );
      if (inserted.rows.length === 0) {
        throw new TrioHttpError(409, 'COMMITMENT_ALREADY_ENDED');
      }
      await appendEvent(tx, 'CommitmentEnded', {
        commitment_id: commitmentId,
        merchant_id: found.rows[0]!.merchant_id,
        ended_at: endedAt,
        ...(request.reason ? { reason: request.reason } : {}),
      });
      return { commitment_id: commitmentId, ended_at: endedAt } as CommitmentEndResponse;
    });
  }

  async status(commitmentId: string): Promise<CommitmentStatus> {
    const { rows } = await this.deps.pool.query<{
      body: unknown;
      ended_at: string | null;
      conversions_used: number;
      budget_remaining_pence: string | null;
    }>(
      `SELECT c.body, t.ended_at, k.conversions_used, k.budget_remaining_pence
         FROM trio.commitments c
         LEFT JOIN trio.commitment_terminations t USING (commitment_id)
         LEFT JOIN trio.counters k USING (commitment_id)
        WHERE c.commitment_id = $1`,
      [commitmentId],
    );
    if (rows.length === 0) throw new TrioHttpError(404, 'COMMITMENT_NOT_FOUND');
    const row = rows[0]!;
    const cor = Commitment.parse(row.body);
    const now = this.deps.clock.now();

    let status: CommitmentStatus['status'] = 'live';
    if (row.ended_at) status = 'ended';
    else if (now < new Date(cor.terms.valid_from)) status = 'not_yet_valid';
    else if (now > new Date(cor.terms.valid_until)) status = 'expired';

    return {
      commitment_id: cor.commitment_id,
      status,
      conversions_used: row.conversions_used ?? 0,
      max_conversions: cor.terms.max_conversions,
      budget_remaining:
        row.budget_remaining_pence === null ? null : pence(Number(row.budget_remaining_pence)),
    };
  }

  /** Internal: load a COR (used by mint + verification). */
  async load(commitmentId: string): Promise<Commitment | null> {
    const { rows } = await this.deps.pool.query<{ body: unknown }>(
      'SELECT body FROM trio.commitments WHERE commitment_id = $1',
      [commitmentId],
    );
    return rows.length ? Commitment.parse(rows[0]!.body) : null;
  }
}

/**
 * Custodied merchant keypair issuance SIMULATOR (MER-2 → SYN-22; same
 * PH1-24 swap unit as commitment signing). Only the key REFERENCE and the
 * public half ever cross the wire — private material stays in custody
 * (FakeSigner now; KMS-enveloped Ed25519 in Phase 1). Idempotent by
 * construction: the ref is deterministic per merchant.
 */
export class MerchantKeySimulator implements MerchantKeyService {
  constructor(private readonly deps: TrioDeps) {}

  async issueMerchantKey(requestInput: MerchantKeyRequest): Promise<MerchantKeyResponse> {
    const request = MerchantKeyRequest.parse(requestInput);
    const signing_key_ref = merchantKeyRef(request.merchant_id);
    return { signing_key_ref, public_key: await this.deps.signer.getPublicKey(signing_key_ref) };
  }

  /** Custodied-key signing call (PH1-24): payload in, signature out — the
   * private key never crosses the wire. MER-4's adapter and the contract
   * harness's real-crypto branch are the callers. */
  async signForMerchant(
    merchantId: string,
    requestInput: MerchantKeySignRequest,
  ): Promise<MerchantKeySignResponse> {
    const request = MerchantKeySignRequest.parse(requestInput);
    const parsed = MerchantKeyRequest.parse({ merchant_id: merchantId });
    const signing_key_ref = merchantKeyRef(parsed.merchant_id);
    return { signing_key_ref, signature: await this.deps.signer.sign(signing_key_ref, request.payload) };
  }
}
