import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { assertKeyRef, type Signer } from './signer.js';
import type { KeyStore, StoredKeyRecord } from './key-store.js';
import type { Kms } from './kms.js';

const SIG_PREFIX = 'ed25519:';
const PUB_PREFIX = 'ed25519-pub:';

/**
 * Real Ed25519 signer (PH1-30, SYN-32 custody model). Library-only
 * primitives — node:crypto Ed25519 + AES-256-GCM; nothing hand-rolled.
 *
 * Custody: each key ref gets its own Ed25519 keypair, generated in-process
 * on first use. The private key (PKCS8 DER) is sealed with AES-256-GCM
 * under a fresh KMS data key, with the KEY REF as AAD — a sealed key
 * copied onto another ref refuses to open. At rest: only sealed material
 * (`StoredKeyRecord`). In memory: decrypted keys live solely in this
 * instance's cache as non-exported `KeyObject`s; the recorded deviation
 * from arch §6 ("never raw keys in process") stands per SYN-32, with
 * native-Ed25519 KMS as the upgrade path.
 *
 * Signatures are `ed25519:`-prefixed — structurally disjoint from
 * FakeSigner's `fake-ed25519:` tag, and verify() refuses anything not
 * carrying the real prefix, so a fake signature can NEVER verify here.
 */
export class Ed25519Signer implements Signer {
  private readonly privateKeys = new Map<string, KeyObject>();
  private readonly publicKeys = new Map<string, KeyObject>();

  constructor(
    private readonly kms: Kms,
    private readonly store: KeyStore,
  ) {}

  private async seal(keyRef: string, pkcs8: Buffer, publicSpki: Buffer): Promise<StoredKeyRecord> {
    const dataKey = await this.kms.generateDataKey();
    const iv = randomBytes(12);
    const { sealed, tag } = dataKey.plaintext.use((dk) => {
      const cipher = createCipheriv('aes-256-gcm', dk, iv);
      cipher.setAAD(Buffer.from(keyRef, 'utf8'));
      const sealed = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
      return { sealed, tag: cipher.getAuthTag() };
    });
    return {
      key_ref: keyRef,
      public_key: publicSpki.toString('base64'),
      encrypted_private: sealed.toString('base64'),
      encrypted_data_key: dataKey.ciphertextBlob.toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: tag.toString('base64'),
      created_at: new Date().toISOString(),
    };
  }

  private async open(record: StoredKeyRecord): Promise<KeyObject> {
    const dataKey = await this.kms.decryptDataKey(Buffer.from(record.encrypted_data_key, 'base64'));
    const pkcs8 = dataKey.use((dk) => {
      const decipher = createDecipheriv('aes-256-gcm', dk, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(record.key_ref, 'utf8'));
      decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(record.encrypted_private, 'base64')),
        decipher.final(),
      ]);
    });
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  }

  private async ensureKey(keyRef: string): Promise<void> {
    if (this.privateKeys.has(keyRef)) return;
    let record = await this.store.load(keyRef);
    if (!record) {
      const pair = generateKeyPairSync('ed25519');
      const candidate = await this.seal(
        keyRef,
        pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
        pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
      );
      // first writer wins — adopt whatever the store made canonical
      record = await this.store.putIfAbsent(candidate);
    }
    this.privateKeys.set(keyRef, await this.open(record));
    this.publicKeys.set(
      keyRef,
      createPublicKey({ key: Buffer.from(record.public_key, 'base64'), format: 'der', type: 'spki' }),
    );
  }

  async sign(keyRef: string, payload: string): Promise<string> {
    assertKeyRef(keyRef);
    await this.ensureKey(keyRef);
    const signature = edSign(null, Buffer.from(payload, 'utf8'), this.privateKeys.get(keyRef)!);
    return `${SIG_PREFIX}${signature.toString('base64url')}`;
  }

  async verify(keyRef: string, payload: string, signature: string): Promise<boolean> {
    assertKeyRef(keyRef);
    if (!signature.startsWith(SIG_PREFIX)) return false; // fake- and foreign tags refuse structurally
    const record = await this.store.load(keyRef);
    if (!record && !this.publicKeys.has(keyRef)) return false; // unknown key = untrusted
    await this.ensureKey(keyRef);
    try {
      return edVerify(
        null,
        Buffer.from(payload, 'utf8'),
        this.publicKeys.get(keyRef)!,
        Buffer.from(signature.slice(SIG_PREFIX.length), 'base64url'),
      );
    } catch {
      return false;
    }
  }

  async getPublicKey(keyRef: string): Promise<string> {
    assertKeyRef(keyRef);
    await this.ensureKey(keyRef);
    const spki = this.publicKeys.get(keyRef)!.export({ format: 'der', type: 'spki' }) as Buffer;
    return `${PUB_PREFIX}${spki.toString('base64url')}`;
  }

  /**
   * TRIO-INTERNAL (PH1-25): run `fn` with the live private KeyObject — the
   * PASETO library signs whole tokens itself, so the mint needs the key,
   * not a detached signature. The key never leaves the callback's scope and
   * this method must only be called inside the trio process (SYN-32 custody
   * boundary); it exists so PASETO stays library-built, never hand-rolled.
   */
  async usePrivateKey<T>(keyRef: string, fn: (privateKey: KeyObject) => Promise<T>): Promise<T> {
    assertKeyRef(keyRef);
    await this.ensureKey(keyRef);
    return fn(this.privateKeys.get(keyRef)!);
  }

  /** The public half as a KeyObject (verification-side counterpart). */
  async usePublicKey<T>(keyRef: string, fn: (publicKey: KeyObject) => Promise<T>): Promise<T> {
    assertKeyRef(keyRef);
    await this.ensureKey(keyRef);
    return fn(this.publicKeys.get(keyRef)!);
  }
}
