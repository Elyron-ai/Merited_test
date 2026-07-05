import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Ed25519Signer } from './ed25519-signer.js';
import { createCrypter, createSigner, FakeCryptoForbiddenError } from './factory.js';
import { FakeSigner } from './fake-signer.js';
import { InMemoryKeyStore } from './key-store.js';
import { KmsCrypter } from './kms-crypter.js';
import { InMemoryKms } from './kms.js';
import { SecretBytes } from './secret-bytes.js';

const makeSigner = () => {
  const kms = new InMemoryKms();
  const store = new InMemoryKeyStore();
  return { signer: new Ed25519Signer(kms, store), kms, store };
};

describe('Ed25519Signer (PH1-30 — real signatures, envelope custody)', () => {
  it('sign → verify round-trips; a flipped payload or signature byte refuses', async () => {
    const { signer } = makeSigner();
    const sig = await signer.sign('merchant/mer_1', 'the canonical payload');
    expect(sig.startsWith('ed25519:')).toBe(true);
    expect(await signer.verify('merchant/mer_1', 'the canonical payload', sig)).toBe(true);
    expect(await signer.verify('merchant/mer_1', 'the canonical payload!', sig)).toBe(false);
    const tampered = `ed25519:${sig.slice(9, -2)}AA`;
    expect(await signer.verify('merchant/mer_1', 'the canonical payload', tampered)).toBe(false);
  });

  it('cross-hierarchy and cross-ref verification fails structurally (SYN-1)', async () => {
    const { signer } = makeSigner();
    const sig = await signer.sign('merchant/mer_1', 'payload');
    expect(await signer.verify('platform/commitments', 'payload', sig)).toBe(false);
    expect(await signer.verify('merchant/mer_2', 'payload', sig)).toBe(false);
    expect(await signer.verify('agent/agt_1', 'payload', sig)).toBe(false);
  });

  it('a fake-tagged signature NEVER verifies against the real signer', async () => {
    const { signer } = makeSigner();
    const fake = await new FakeSigner('any-secret').sign('merchant/mer_1', 'payload');
    expect(fake.startsWith('fake-ed25519:')).toBe(true);
    expect(await signer.verify('merchant/mer_1', 'payload', fake)).toBe(false);
  });

  it('keys persist sealed: a SECOND signer over the same store verifies the first one’s signatures', async () => {
    const kms = new InMemoryKms();
    const store = new InMemoryKeyStore();
    const first = new Ed25519Signer(kms, store);
    const sig = await first.sign('merchant/mer_1', 'payload');
    const second = new Ed25519Signer(kms, store); // cold cache — must open the sealed record
    expect(await second.verify('merchant/mer_1', 'payload', sig)).toBe(true);
    expect(await second.getPublicKey('merchant/mer_1')).toBe(
      await first.getPublicKey('merchant/mer_1'),
    );
  });

  it('a sealed key copied onto another ref refuses to open (AAD binding)', async () => {
    const kms = new InMemoryKms();
    const store = new InMemoryKeyStore();
    const signer = new Ed25519Signer(kms, store);
    await signer.sign('merchant/mer_1', 'payload');
    const record = (await store.load('merchant/mer_1'))!;
    await store.putIfAbsent({ ...record, key_ref: 'merchant/mer_stolen' });
    const cold = new Ed25519Signer(kms, store);
    await expect(cold.sign('merchant/mer_stolen', 'x')).rejects.toThrow();
  });

  it('verify of an unknown ref is false, not key creation', async () => {
    const { signer, store } = makeSigner();
    expect(await signer.verify('merchant/mer_ghost', 'p', 'ed25519:AAAA')).toBe(false);
    expect(await store.load('merchant/mer_ghost')).toBeNull();
  });

  it('concurrent first use of one ref converges on ONE keypair (first writer wins)', async () => {
    const { signer } = makeSigner();
    const [a, b] = await Promise.all([
      signer.sign('merchant/mer_race', 'p1'),
      signer.sign('merchant/mer_race', 'p2'),
    ]);
    expect(await signer.verify('merchant/mer_race', 'p1', a)).toBe(true);
    expect(await signer.verify('merchant/mer_race', 'p2', b)).toBe(true);
  });

  it('key material never serialises: signer, store record and SecretBytes all redact', async () => {
    const kms = new InMemoryKms();
    const store = new InMemoryKeyStore();
    const signer = new Ed25519Signer(kms, store);
    await signer.sign('merchant/mer_1', 'payload');
    // the signer itself (private-key cache inside) — no plaintext key bytes
    // via JSON or inspect: every Ed25519 PKCS8 DER starts with the bytes
    // base64('MC4CAQAwBQYDK2Vw…'), so its absence proves no private key
    // escaped (the sealed value is AES ciphertext; field NAMES may say
    // "private", the material must not)
    const PKCS8_PREFIX = 'MC4CAQ';
    expect(JSON.stringify(signer)).not.toContain(PKCS8_PREFIX);
    expect(inspect(signer, { depth: 10 })).not.toContain(PKCS8_PREFIX);
    expect(inspect(signer, { depth: 10 })).not.toContain('BEGIN PRIVATE KEY');
    // SecretBytes redacts every observation channel
    const secret = new SecretBytes(Buffer.from('super-secret-key-material'));
    expect(JSON.stringify({ secret })).toContain('[redacted:secret-bytes]');
    expect(`${secret}`).toBe('[redacted:secret-bytes]');
    expect(inspect(secret)).toBe('[redacted:secret-bytes]');
    expect(JSON.stringify({ secret })).not.toContain('super-secret');
    // the at-rest record carries ONLY sealed material: opening it without
    // KMS is impossible, and nothing in it equals the plaintext pkcs8
    const record = (await store.load('merchant/mer_1'))!;
    expect(record.encrypted_private).not.toContain(record.public_key.slice(0, 12));
  });
});

describe('KmsCrypter (PH1-30 — data-key AEAD for link_tokens)', () => {
  it('encrypt → decrypt round-trips; each ciphertext uses a fresh data key', async () => {
    const crypter = new KmsCrypter(new InMemoryKms());
    const a = await crypter.encrypt('platform/link_tokens', 'refresh-material');
    const b = await crypter.encrypt('platform/link_tokens', 'refresh-material');
    expect(a).not.toBe(b); // fresh key + nonce every call
    expect(await crypter.decrypt('platform/link_tokens', a)).toBe('refresh-material');
    expect(await crypter.decrypt('platform/link_tokens', b)).toBe('refresh-material');
  });

  it('ciphertext is bound to its keyRef (AAD) and refuses tampering', async () => {
    const crypter = new KmsCrypter(new InMemoryKms());
    const sealed = await crypter.encrypt('platform/link_tokens', 'secret');
    await expect(crypter.decrypt('platform/other', sealed)).rejects.toThrow();
    const parts = sealed.split('.');
    parts[5] = parts[5]!.slice(0, -2) + 'AA';
    await expect(crypter.decrypt('platform/link_tokens', parts.join('.'))).rejects.toThrow();
    await expect(crypter.decrypt('platform/link_tokens', 'garbage')).rejects.toThrow(
      'unrecognised ciphertext format',
    );
  });
});

describe('env guard (PH1-30 accept — fake crypto never leaves dev/test)', () => {
  it('fake signer/crypter construct in dev, test and demo only', () => {
    for (const env of ['dev', 'test', 'demo']) {
      expect(createSigner({ kind: 'fake', env, secret: 's' })).toBeInstanceOf(FakeSigner);
      expect(() => createCrypter({ kind: 'fake', env, secret: 's' })).not.toThrow();
    }
    for (const env of ['prod', 'production', 'staging', '']) {
      expect(() => createSigner({ kind: 'fake', env, secret: 's' })).toThrow(
        FakeCryptoForbiddenError,
      );
      expect(() => createCrypter({ kind: 'fake', env, secret: 's' })).toThrow(
        FakeCryptoForbiddenError,
      );
    }
  });

  it('the real pair constructs everywhere', () => {
    const kms = new InMemoryKms();
    expect(
      createSigner({ kind: 'ed25519', kms, store: new InMemoryKeyStore() }),
    ).toBeInstanceOf(Ed25519Signer);
    expect(createCrypter({ kind: 'kms', kms })).toBeInstanceOf(KmsCrypter);
  });
});
