import {
  AttributionTokenClaims,
  ConversionClaim,
  newId,
  type MeritedId,
  type OrderConfirmed,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import type { Signer } from '@merited/signing';

/**
 * `OrderConfirmed` → signed `ConversionClaim` (MER-4). The merchant
 * signature is produced through the `Signer` INTERFACE against the
 * merchant's custodied key reference — FakeSigner in Phase 0, the trio's
 * real custody in Phase 1 (PH1-24). NO cryptography is implemented in this
 * workstream (§7 boundary); the payload convention is canonical JSON of
 * the claim minus `merchant_sig`, identical to what the trio verifies.
 */
export const buildSignedClaim = async (
  order: OrderConfirmed & { token: string },
  merchant: { merchant_id: MeritedId<'mer'>; signing_key_ref: string },
  signer: Signer,
): Promise<ConversionClaim> => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: merchant.merchant_id,
    attribution_token: order.token,
    order: {
      order_ref_hash: order.order_ref_hash,
      gross_value: order.gross_value,
      ts: order.ts,
    },
  };
  const merchant_sig = await signer.sign(merchant.signing_key_ref, canonicalJson(base));
  return ConversionClaim.parse({ ...base, merchant_sig });
};

/** Best-effort decode of the token's claims section — METADATA ONLY (the
 * trio, not the adapter, decides trust). Returns null for opaque garbage. */
export const decodeTokenClaims = (token: string): AttributionTokenClaims | null => {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  try {
    return AttributionTokenClaims.parse(
      JSON.parse(Buffer.from(parts[3]!, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
};
