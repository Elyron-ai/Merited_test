import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { assertKeyRef, type Crypter } from './signer.js';

const PREFIX = 'fake-kms:';

export class DecryptionError extends Error {
  constructor() {
    // Deliberately carries neither plaintext, ciphertext, nor key material.
    super('decryption failed: ciphertext invalid or tampered');
    this.name = 'DecryptionError';
  }
}

/**
 * Deterministic local Crypter for Phase 0 (BUILD-SPEC §6.2): AES-256-GCM with
 * a key derived from (secret, keyRef); ciphertexts tagged `fake-kms:` so they
 * can never be mistaken for real KMS envelopes. Real KMS data-key envelope
 * encryption is PH1-30 — not here.
 */
export class FakeCrypter implements Crypter {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('FakeCrypter requires a non-empty secret');
  }

  private key(keyRef: string): Buffer {
    return createHash('sha256').update(`${this.secret}\n${assertKeyRef(keyRef)}`).digest();
  }

  encrypt(keyRef: string, plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(keyRef), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve(`${PREFIX}${Buffer.concat([iv, tag, ct]).toString('base64')}`);
  }

  decrypt(keyRef: string, ciphertext: string): Promise<string> {
    try {
      if (!ciphertext.startsWith(PREFIX)) throw new Error('bad prefix');
      const raw = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.key(keyRef), iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return Promise.resolve(pt.toString('utf8'));
    } catch {
      // Collapse every failure mode into one hygienic error (no secret leak).
      return Promise.reject(new DecryptionError());
    }
  }
}
