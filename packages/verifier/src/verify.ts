import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import {
  AttributionTokenClaims,
  ProofPack,
  type ConversionClaim,
  type Commitment,
} from '@merited/contracts';
import { canonicalize } from 'json-canonicalize';
import { V4 } from 'paseto';

/**
 * The reference verifier (PH3-8) — implemented STRICTLY against
 * docs/spec/verification.md (the doc is the source of truth; this package
 * deliberately imports nothing from core, the trio or the events package).
 * Offline by construction: no network calls anywhere; the proof pack is the
 * entire input. Fail closed: any check that cannot be completed is INVALID.
 */

export type VerifierResult =
  | { outcome: 'VERIFIED'; claim_id: string; verified_at: string }
  | { outcome: 'REJECTED'; claim_id: string; reason_code: string }
  | { outcome: 'INVALID'; step: 'pack' | 'chain' | 'cor' | 'token' | 'claim' | 'verdict'; detail: string };

// ——— spec §2 primitives, reimplemented from the doc ————————————————————————

const sha256hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/** RFC 8785 (JCS) — spec §2: a verifier needs plain JCS. */
const jcs = (value: unknown): string => canonicalize(value);

const SIG_PREFIX = 'ed25519:';

const keyFromSpkiBase64 = (spkiBase64: string): KeyObject =>
  createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });

/** Spec §2 signature encoding: `ed25519:` + base64url(raw 64-byte sig),
 * Ed25519 over the UTF-8 bytes of the canonical payload. Anything else —
 * including dev fake signatures (Appendix A) — refuses structurally. */
const signatureVerifies = (publicKeySpkiBase64: string, payload: string, signature: string): boolean => {
  if (!signature.startsWith(SIG_PREFIX)) return false;
  try {
    return edVerify(
      null,
      Buffer.from(payload, 'utf8'),
      keyFromSpkiBase64(publicKeySpkiBase64),
      Buffer.from(signature.slice(SIG_PREFIX.length), 'base64url'),
    );
  } catch {
    return false;
  }
};

// ——— spec §5/§7 signature payloads ——————————————————————————————————————————

const corUnsignedPayload = (cor: Commitment): string => {
  const { merchant_sig: _m, platform_sig: _p, ...rest } = cor;
  return jcs(rest);
};

const corMerchantSignedPayload = (cor: Commitment): string => {
  const { platform_sig: _p, ...rest } = cor;
  return jcs(rest);
};

const claimUnsignedPayload = (claim: ConversionClaim): string => {
  const { merchant_sig: _m, ...rest } = claim;
  return jcs(rest);
};

// ——— the five normative steps (spec §9) —————————————————————————————————————

interface EventRow {
  seq: number;
  type: string;
  body: unknown;
  prev_hash: string;
  this_hash: string;
}

const eventData = (row: EventRow): Record<string, unknown> =>
  ((row.body as { data?: Record<string, unknown> }).data ?? {});

export const verifyProofPack = async (input: unknown): Promise<VerifierResult> => {
  // step 0 — the pack itself
  const parsed = ProofPack.safeParse(input);
  if (!parsed.success) {
    return { outcome: 'INVALID', step: 'pack', detail: parsed.error.issues[0]?.message ?? 'malformed pack' };
  }
  const pack = parsed.data;
  const events = pack.events as EventRow[];

  // step 1 — chain: recompute, continuity, anchor (spec §3)
  for (let i = 0; i < events.length; i += 1) {
    const row = events[i]!;
    let canonicalBody: string;
    try {
      canonicalBody = jcs(row.body);
    } catch {
      return { outcome: 'INVALID', step: 'chain', detail: `seq ${row.seq}: body is not canonicalisable` };
    }
    const recomputed = sha256hex(row.prev_hash + canonicalBody);
    if (recomputed !== row.this_hash) {
      return {
        outcome: 'INVALID',
        step: 'chain',
        detail: `seq ${row.seq}: recomputed hash ${recomputed} does not match this_hash — event bytes mutated`,
      };
    }
    const next = events[i + 1];
    if (next) {
      if (next.seq !== row.seq + 1) {
        return { outcome: 'INVALID', step: 'chain', detail: `slice not contiguous at seq ${row.seq} → ${next.seq}` };
      }
      if (next.prev_hash !== row.this_hash) {
        return { outcome: 'INVALID', step: 'chain', detail: `seq ${next.seq}: prev_hash does not chain from seq ${row.seq}` };
      }
    }
  }
  const last = events[events.length - 1]!;
  const anchored = pack.heads.some((head) => head.seq === last.seq && head.head_hash === last.this_hash);
  if (!anchored) {
    return {
      outcome: 'INVALID',
      step: 'chain',
      detail: `slice ends at seq ${last.seq} / ${last.this_hash} but no published head matches — not anchored`,
    };
  }

  // step 2 — COR: both signatures, then byte-equal anchoring in the slice (spec §5)
  if (!signatureVerifies(pack.keys.merchant_public_key, corUnsignedPayload(pack.cor), pack.cor.merchant_sig)) {
    return { outcome: 'INVALID', step: 'cor', detail: 'merchant_sig does not verify over canonical COR minus both sigs' };
  }
  if (
    !signatureVerifies(
      pack.keys.platform_commitment_public_key,
      corMerchantSignedPayload(pack.cor),
      pack.cor.platform_sig,
    )
  ) {
    return { outcome: 'INVALID', step: 'cor', detail: 'platform_sig (countersign) does not verify' };
  }
  const corEvent = events.find(
    (row) =>
      row.type === 'CommitmentCreated' &&
      (eventData(row)['commitment'] as { commitment_id?: string } | undefined)?.commitment_id ===
        pack.cor.commitment_id,
  );
  if (!corEvent || jcs(eventData(corEvent)['commitment']) !== jcs(pack.cor)) {
    return { outcome: 'INVALID', step: 'cor', detail: 'COR is not anchored byte-equal in a CommitmentCreated event' };
  }

  // step 3 — token: PASETO v4.public with the mint key; claims bind to the COR (spec §6)
  const token = pack.claim.attribution_token;
  if (token.startsWith('v4.public.fake.') || !token.startsWith('v4.public.')) {
    return { outcome: 'INVALID', step: 'token', detail: 'not a PASETO v4.public token (dev formats refuse structurally)' };
  }
  let mc: AttributionTokenClaims;
  try {
    const payload = (await V4.verify(token, keyFromSpkiBase64(pack.keys.platform_mint_public_key))) as {
      mc: unknown;
    };
    mc = AttributionTokenClaims.parse(payload.mc);
  } catch {
    return { outcome: 'INVALID', step: 'token', detail: 'PASETO signature or claims shape invalid' };
  }
  if (mc.cid !== pack.cor.commitment_id) {
    return { outcome: 'INVALID', step: 'token', detail: `token cid ${mc.cid} does not name the pack COR` };
  }
  const mintEvent = events.find(
    (row) => row.type === 'TokenMinted' && (eventData(row)['claims'] as { jti?: string } | undefined)?.jti === mc.jti,
  );
  if (!mintEvent || jcs(eventData(mintEvent)['claims']) !== jcs(mc)) {
    return { outcome: 'INVALID', step: 'token', detail: 'token claims are not anchored byte-equal in a TokenMinted event' };
  }

  // step 4 — claim: merchant signature + ConversionClaimed anchoring (spec §7)
  if (!signatureVerifies(pack.keys.merchant_public_key, claimUnsignedPayload(pack.claim), pack.claim.merchant_sig)) {
    return { outcome: 'INVALID', step: 'claim', detail: 'claim merchant_sig does not verify' };
  }
  const claimedEvent = events.find(
    (row) => row.type === 'ConversionClaimed' && eventData(row)['claim_id'] === pack.claim.claim_id,
  );
  if (!claimedEvent) {
    return { outcome: 'INVALID', step: 'claim', detail: 'no ConversionClaimed event for the claim in the slice' };
  }
  const claimed = eventData(claimedEvent);
  const bindings: Array<[string, string]> = [
    ['jti', mc.jti],
    ['qid', mc.qid],
    ['cid', mc.cid],
    ['order_ref_hash', pack.claim.order.order_ref_hash],
  ];
  for (const [field, expected] of bindings) {
    if (claimed[field] !== expected) {
      return { outcome: 'INVALID', step: 'claim', detail: `ConversionClaimed.${field} does not match` };
    }
  }
  if (jcs(claimed['gross_value']) !== jcs(pack.claim.order.gross_value)) {
    return { outcome: 'INVALID', step: 'claim', detail: 'ConversionClaimed.gross_value does not match the claim' };
  }

  // step 5 — the verdict is what the anchored ledger says (spec §8)
  const verdictEvent = events.find(
    (row) =>
      (row.type === 'ConversionVerified' || row.type === 'ConversionRejected') &&
      eventData(row)['claim_id'] === pack.claim.claim_id,
  );
  if (!verdictEvent) {
    return { outcome: 'INVALID', step: 'verdict', detail: 'no verdict event for the claim in the slice' };
  }
  if (verdictEvent.type === 'ConversionVerified') {
    return {
      outcome: 'VERIFIED',
      claim_id: pack.claim.claim_id,
      verified_at: String(eventData(verdictEvent)['verified_at']),
    };
  }
  return {
    outcome: 'REJECTED',
    claim_id: pack.claim.claim_id,
    reason_code: String(eventData(verdictEvent)['reason_code']),
  };
};
