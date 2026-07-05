import {
  createCipheriv,
  createDecipheriv,
  createHash,
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
 * Real Ed25519 signer (PH1-30, SYN-32 custody model; versioned for rotation
 * at PH1-22). Library-only primitives — node:crypto Ed25519 + AES-256-GCM;
 * nothing hand-rolled.
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
 * Rotation (PH1-22): a ref holds VERSIONS (key ids). `sign()` always uses
 * the newest active version; `verify()` tries every non-revoked version,
 * newest first — so artefacts signed under key N verify after rotation to
 * N+1 with NO change to signature or token formats. `rotateKey()` adds a
 * version; `revokeKeyVersion()` is the compromise path — everything a
 * revoked version signed stops verifying.
 *
 * Signatures are `ed25519:`-prefixed — structurally disjoint from
 * FakeSigner's `fake-ed25519:` tag, and verify() refuses anything not
 * carrying the real prefix, so a fake signature can NEVER verify here.
 */
export class Ed25519Signer implements Signer {
  /** Opened keys per VERSION: `${keyRef}#${keyId}`. */
  private readonly privateKeys = new Map<string, KeyObject>();
  private readonly publicKeys = new Map<string, KeyObject>();
  /** The signing (newest active) key id per ref. */
  private readonly current = new Map<string, string>();

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
      // PH1-22 key-id convention: content-derived version id
      key_id: createHash('sha256').update(publicSpki).digest('hex').slice(0, 12),
      public_key: publicSpki.toString('base64'),
      encrypted_private: sealed.toString('base64'),
      encrypted_data_key: dataKey.ciphertextBlob.toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: tag.toString('base64'),
      created_at: new Date().toISOString(),
      revoked_at: null,
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

  private versionKey(record: StoredKeyRecord): string {
    return `${record.key_ref}#${record.key_id}`;
  }

  /** Open + cache one stored version (private optional — verify needs public only). */
  private async cacheVersion(record: StoredKeyRecord, withPrivate: boolean): Promise<void> {
    const cacheKey = this.versionKey(record);
    if (!this.publicKeys.has(cacheKey)) {
      this.publicKeys.set(
        cacheKey,
        createPublicKey({ key: Buffer.from(record.public_key, 'base64'), format: 'der', type: 'spki' }),
      );
    }
    if (withPrivate && !this.privateKeys.has(cacheKey)) {
      this.privateKeys.set(cacheKey, await this.open(record));
    }
  }

  /** Resolve (creating on first use) the newest active version for a ref. */
  private async ensureCurrent(keyRef: string): Promise<string> {
    const cached = this.current.get(keyRef);
    if (cached) return cached;
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
    await this.cacheVersion(record, true);
    this.current.set(keyRef, record.key_id);
    return record.key_id;
  }

  /** All verification candidates for a ref (non-revoked versions), cached. */
  private async verificationCandidates(keyRef: string): Promise<StoredKeyRecord[]> {
    const versions = await this.store.loadVersions(keyRef);
    for (const version of versions) await this.cacheVersion(version, false);
    return versions;
  }

  async sign(keyRef: string, payload: string): Promise<string> {
    assertKeyRef(keyRef);
    const keyId = await this.ensureCurrent(keyRef);
    const signature = edSign(
      null,
      Buffer.from(payload, 'utf8'),
      this.privateKeys.get(`${keyRef}#${keyId}`)!,
    );
    return `${SIG_PREFIX}${signature.toString('base64url')}`;
  }

  async verify(keyRef: string, payload: string, signature: string): Promise<boolean> {
    assertKeyRef(keyRef);
    if (!signature.startsWith(SIG_PREFIX)) return false; // fake- and foreign tags refuse structurally
    const versions = await this.verificationCandidates(keyRef);
    if (versions.length === 0) return false; // unknown or fully revoked key = untrusted
    const sig = Buffer.from(signature.slice(SIG_PREFIX.length), 'base64url');
    const payloadBytes = Buffer.from(payload, 'utf8');
    for (const version of versions) {
      try {
        if (edVerify(null, payloadBytes, this.publicKeys.get(this.versionKey(version))!, sig)) {
          return true;
        }
      } catch {
        // malformed signature bytes — keep failing closed
      }
    }
    return false;
  }

  async getPublicKey(keyRef: string): Promise<string> {
    assertKeyRef(keyRef);
    const keyId = await this.ensureCurrent(keyRef);
    const spki = this.publicKeys.get(`${keyRef}#${keyId}`)!.export({ format: 'der', type: 'spki' }) as Buffer;
    return `${PUB_PREFIX}${spki.toString('base64url')}`;
  }

  /**
   * Rotation (PH1-22, runbook step 2): generate + seal a NEW version; it
   * becomes the signing key immediately. Prior versions keep verifying
   * until individually revoked.
   */
  async rotateKey(keyRef: string): Promise<{ key_id: string }> {
    assertKeyRef(keyRef);
    const pair = generateKeyPairSync('ed25519');
    const record = await this.store.rotate(
      await this.seal(
        keyRef,
        pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
        pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
      ),
    );
    await this.cacheVersion(record, true);
    this.current.set(keyRef, record.key_id);
    return { key_id: record.key_id };
  }

  /**
   * Compromise path (PH1-22, runbook step 3): revoke ONE version — every
   * artefact it signed stops verifying, in this instance immediately and
   * everywhere else on the next store read.
   */
  async revokeKeyVersion(keyRef: string, keyId: string): Promise<boolean> {
    assertKeyRef(keyRef);
    const flipped = await this.store.revokeVersion(keyRef, keyId);
    this.privateKeys.delete(`${keyRef}#${keyId}`);
    this.publicKeys.delete(`${keyRef}#${keyId}`);
    if (this.current.get(keyRef) === keyId) this.current.delete(keyRef);
    return flipped;
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
    const keyId = await this.ensureCurrent(keyRef);
    return fn(this.privateKeys.get(`${keyRef}#${keyId}`)!);
  }

  /** The CURRENT public half as a KeyObject (mint-side counterpart). */
  async usePublicKey<T>(keyRef: string, fn: (publicKey: KeyObject) => Promise<T>): Promise<T> {
    assertKeyRef(keyRef);
    const keyId = await this.ensureCurrent(keyRef);
    return fn(this.publicKeys.get(`${keyRef}#${keyId}`)!);
  }

  /**
   * Rotation-tolerant verification counterpart (PH1-22): run `fn` against
   * each non-revoked version, newest first, returning the first success.
   * Throws the LAST failure when no version accepts — callers treat any
   * throw as fail-closed (the PASETO codec returns null).
   */
  async usePublicKeyVersions<T>(keyRef: string, fn: (publicKey: KeyObject) => Promise<T>): Promise<T> {
    assertKeyRef(keyRef);
    const versions = await this.verificationCandidates(keyRef);
    if (versions.length === 0) throw new Error(`no active key versions for '${keyRef}'`);
    let lastError: unknown = new Error('unreachable');
    for (const version of versions) {
      try {
        return await fn(this.publicKeys.get(this.versionKey(version))!);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
