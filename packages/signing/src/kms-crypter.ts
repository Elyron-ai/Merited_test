import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assertKeyRef } from './signer.js';
import type { Crypter } from './signer.js';
import type { Kms } from './kms.js';

const PREFIX = 'kmsenc.v1';

/**
 * KMS-data-key AEAD Crypter (PH1-30 → PH1-8's `link_tokens` store).
 * Envelope per ciphertext: a fresh data key from KMS seals the plaintext
 * with AES-256-GCM, keyRef bound as AAD — ciphertext moved to a different
 * ref refuses to open. Wire format (all base64url):
 * `kmsenc.v1.<edk>.<iv>.<tag>.<ct>` — versioned so a future scheme can
 * coexist during rotation.
 */
export class KmsCrypter implements Crypter {
  constructor(private readonly kms: Kms) {}

  async encrypt(keyRef: string, plaintext: string): Promise<string> {
    assertKeyRef(keyRef);
    const dataKey = await this.kms.generateDataKey();
    const iv = randomBytes(12);
    const { sealed, tag } = dataKey.plaintext.use((dk) => {
      const cipher = createCipheriv('aes-256-gcm', dk, iv);
      cipher.setAAD(Buffer.from(keyRef, 'utf8'));
      const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { sealed, tag: cipher.getAuthTag() };
    });
    const parts = [
      dataKey.ciphertextBlob.toString('base64url'),
      iv.toString('base64url'),
      tag.toString('base64url'),
      sealed.toString('base64url'),
    ];
    return `${PREFIX}.${parts.join('.')}`;
  }

  async decrypt(keyRef: string, ciphertext: string): Promise<string> {
    assertKeyRef(keyRef);
    const parts = ciphertext.split('.');
    if (parts.length !== 6 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      throw new Error('KmsCrypter: unrecognised ciphertext format');
    }
    const [, , edk, iv, tag, ct] = parts;
    const dataKey = await this.kms.decryptDataKey(Buffer.from(edk!, 'base64url'));
    return dataKey.use((dk) => {
      const decipher = createDecipheriv('aes-256-gcm', dk, Buffer.from(iv!, 'base64url'));
      decipher.setAAD(Buffer.from(keyRef, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    });
  }
}
