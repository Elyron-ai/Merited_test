/**
 * Signing interfaces (BUILD-SPEC §2.2 row 1; architecture §6 key hierarchy).
 *
 * ── SYN-32 boundary ─────────────────────────────────────────────────────────
 * Real implementations (Ed25519 with KMS-enveloped keys) land in Phase 1 as
 * PH1-30. NO real cryptography in Phase 0 — this package ships interfaces and
 * deterministic fakes only.
 *
 * Key refs are namespaced by hierarchy (SYN-1): `platform/<name>`,
 * `merchant/<mer_...>`, `agent/<agt_...>` — a signature made under one
 * hierarchy never verifies under another.
 */
export type KeyHierarchy = 'platform' | 'merchant' | 'agent';

const KEY_REF_PATTERN = /^(platform|merchant|agent)\/[A-Za-z0-9_-]+$/;

export class InvalidKeyRefError extends Error {
  constructor(keyRef: string) {
    super(`invalid key ref '${keyRef}' — expected <platform|merchant|agent>/<id>`);
    this.name = 'InvalidKeyRefError';
  }
}

export const assertKeyRef = (keyRef: string): string => {
  if (!KEY_REF_PATTERN.test(keyRef)) throw new InvalidKeyRefError(keyRef);
  return keyRef;
};

export const keyHierarchy = (keyRef: string): KeyHierarchy =>
  assertKeyRef(keyRef).split('/')[0] as KeyHierarchy;

export interface Signer {
  sign(keyRef: string, payload: string): Promise<string>;
  verify(keyRef: string, payload: string, signature: string): Promise<boolean>;
  getPublicKey(keyRef: string): Promise<string>;
}

export interface Crypter {
  encrypt(keyRef: string, plaintext: string): Promise<string>;
  decrypt(keyRef: string, ciphertext: string): Promise<string>;
}
