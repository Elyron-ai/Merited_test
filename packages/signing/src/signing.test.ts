import { describe, expect, it } from 'vitest';
import { DecryptionError, FakeCrypter } from './fake-crypter.js';
import { FakeSigner } from './fake-signer.js';
import { assertKeyRef, InvalidKeyRefError, keyHierarchy } from './signer.js';

const SECRET = 'unit-test-signing-secret';
const signer = new FakeSigner(SECRET);
const crypter = new FakeCrypter(SECRET);
const MERCHANT_KEY = 'merchant/mer_01J0000000000000000000000A';
const PLATFORM_KEY = 'platform/mint';

describe('key refs (SYN-1 hierarchy namespacing)', () => {
  it('accepts hierarchy-namespaced refs and rejects others', () => {
    expect(assertKeyRef(PLATFORM_KEY)).toBe(PLATFORM_KEY);
    expect(keyHierarchy(MERCHANT_KEY)).toBe('merchant');
    expect(() => assertKeyRef('mint')).toThrow(InvalidKeyRefError);
    expect(() => assertKeyRef('kms/mint')).toThrow(InvalidKeyRefError);
    expect(() => assertKeyRef('platform/')).toThrow(InvalidKeyRefError);
  });
});

describe('FakeSigner (FND-8 accept)', () => {
  it('is deterministic: same inputs → same signature, tagged fake-ed25519:', async () => {
    const a = await signer.sign(MERCHANT_KEY, 'payload-1');
    const b = await signer.sign(MERCHANT_KEY, 'payload-1');
    expect(a).toBe(b);
    expect(a.startsWith('fake-ed25519:')).toBe(true);
  });

  it('verify accepts its own signatures', async () => {
    const sig = await signer.sign(MERCHANT_KEY, 'payload-1');
    expect(await signer.verify(MERCHANT_KEY, 'payload-1', sig)).toBe(true);
  });

  it('rejects tampered payload, tampered signature, and wrong keyRef', async () => {
    const sig = await signer.sign(MERCHANT_KEY, 'payload-1');
    expect(await signer.verify(MERCHANT_KEY, 'payload-2', sig)).toBe(false);
    expect(await signer.verify(MERCHANT_KEY, 'payload-1', sig.slice(0, -2) + 'ff')).toBe(false);
    expect(await signer.verify('merchant/mer_01J0000000000000000000000B', 'payload-1', sig)).toBe(
      false,
    );
  });

  it('cross-hierarchy verification fails (a merchant sig never verifies as platform — SYN-1)', async () => {
    const sig = await signer.sign(MERCHANT_KEY, 'claim-body');
    expect(await signer.verify(PLATFORM_KEY, 'claim-body', sig)).toBe(false);
  });

  it('different secrets produce different, mutually-unverifiable signatures', async () => {
    const other = new FakeSigner('another-secret');
    const sig = await signer.sign(PLATFORM_KEY, 'x');
    expect(await other.verify(PLATFORM_KEY, 'x', sig)).toBe(false);
  });

  it('public keys are deterministic and secret-independent', async () => {
    expect(await signer.getPublicKey(PLATFORM_KEY)).toBe(
      await new FakeSigner('different').getPublicKey(PLATFORM_KEY),
    );
    expect((await signer.getPublicKey(PLATFORM_KEY)).startsWith('fake-pub:')).toBe(true);
  });
});

describe('FakeCrypter (FND-8 accept)', () => {
  it('round-trips plaintext with fake-kms: tagged ciphertext', async () => {
    const ct = await crypter.encrypt(MERCHANT_KEY, 'refresh-token-material');
    expect(ct.startsWith('fake-kms:')).toBe(true);
    expect(await crypter.decrypt(MERCHANT_KEY, ct)).toBe('refresh-token-material');
  });

  it('rejects tampered ciphertext and wrong keyRef', async () => {
    const ct = await crypter.encrypt(MERCHANT_KEY, 'secret-value');
    const raw = Buffer.from(ct.slice('fake-kms:'.length), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = 'fake-kms:' + raw.toString('base64');
    await expect(crypter.decrypt(MERCHANT_KEY, tampered)).rejects.toThrow(DecryptionError);
    await expect(crypter.decrypt(PLATFORM_KEY, ct)).rejects.toThrow(DecryptionError);
    await expect(crypter.decrypt(MERCHANT_KEY, 'not-an-envelope')).rejects.toThrow(DecryptionError);
  });

  it('error hygiene: thrown errors never contain the secret or the plaintext (FND-8 accept)', async () => {
    const plaintext = 'super-sensitive-plaintext';
    const ct = await crypter.encrypt(MERCHANT_KEY, plaintext);
    const errors: string[] = [];
    try {
      await crypter.decrypt(PLATFORM_KEY, ct);
    } catch (error) {
      errors.push(String(error), (error as Error).stack ?? '');
    }
    try {
      await signer.sign('bad-ref', 'x');
    } catch (error) {
      errors.push(String(error), (error as Error).stack ?? '');
    }
    expect(errors.length).toBeGreaterThan(0);
    for (const text of errors) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(plaintext);
    }
  });
});
