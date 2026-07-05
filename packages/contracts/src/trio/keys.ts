import { z } from 'zod';
import { Id } from '../ids.js';

/**
 * Custodied merchant keypair issuance (MER-2 → SYN-22): §7 omits this
 * endpoint, so the contract is added here (additive to the frozen M1
 * surface). Phase 0 serves it from the commitment simulator via
 * `FakeSigner.getPublicKey`; PH1-24 makes it real (KMS-custodied Ed25519).
 * Only ever a key REFERENCE + public key on the wire — private material
 * never leaves trio custody.
 */
export const MerchantKeyRequest = z.object({
  merchant_id: Id('mer'),
});
export type MerchantKeyRequest = z.infer<typeof MerchantKeyRequest>;

export const MerchantKeyResponse = z.object({
  signing_key_ref: z.string().min(1),
  public_key: z.string().min(1),
});
export type MerchantKeyResponse = z.infer<typeof MerchantKeyResponse>;

/** Custodied-key SIGNING call (PH1-24, XC.7's "custodied-key signing
 * calls"): the adapter/harness sends the canonical payload, the signature
 * comes back — the private key never crosses the wire. Sits behind the
 * service token; per-caller authorisation is SYN-24's Phase-1 hardening
 * item (mTLS/scoped service tokens), flagged for LEAD-5. */
export const MerchantKeySignRequest = z.object({
  payload: z.string().min(1),
});
export type MerchantKeySignRequest = z.infer<typeof MerchantKeySignRequest>;

export const MerchantKeySignResponse = z.object({
  signing_key_ref: z.string().min(1),
  signature: z.string().min(1),
});
export type MerchantKeySignResponse = z.infer<typeof MerchantKeySignResponse>;

export interface MerchantKeyService {
  issueMerchantKey(request: MerchantKeyRequest): Promise<MerchantKeyResponse>;
  signForMerchant(merchantId: string, request: MerchantKeySignRequest): Promise<MerchantKeySignResponse>;
}
