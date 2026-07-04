import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { assertKeyRef, type Signer } from './signer.js';

const PREFIX = 'fake-ed25519:';

/**
 * Deterministic pseudo-signer for Phase 0 (BUILD-SPEC §2.2/§7.1): HMAC-SHA256
 * tagged `fake-ed25519:` so a fake signature can never be mistaken for a real
 * one. The keyRef is part of the MAC input, so cross-hierarchy verification
 * fails structurally (SYN-1). Real Ed25519/KMS is PH1-30 — not here.
 */
export class FakeSigner implements Signer {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('FakeSigner requires a non-empty secret (MERITED_FAKE_SIGNER_SECRET)');
  }

  sign(keyRef: string, payload: string): Promise<string> {
    assertKeyRef(keyRef);
    const mac = createHmac('sha256', this.secret).update(`${keyRef}\n${payload}`).digest('hex');
    return Promise.resolve(`${PREFIX}${mac}`);
  }

  async verify(keyRef: string, payload: string, signature: string): Promise<boolean> {
    assertKeyRef(keyRef);
    if (!signature.startsWith(PREFIX)) return false;
    const expected = await this.sign(keyRef, payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  getPublicKey(keyRef: string): Promise<string> {
    assertKeyRef(keyRef);
    // Deterministic, secret-independent stand-in for a public key.
    return Promise.resolve(`fake-pub:${createHash('sha256').update(keyRef).digest('hex')}`);
  }
}
