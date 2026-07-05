// @merited/signing — Signer/Crypter interfaces, Phase-0 fakes, and the
// PH1-30 real implementations (Ed25519 + KMS-data-key AEAD, SYN-32 custody
// model). Construction goes through the env-guarded factory: fake-tagged
// crypto never leaves dev/test.
export * from './signer.js';
export { FakeSigner } from './fake-signer.js';
export { FakeCrypter, DecryptionError } from './fake-crypter.js';
export { SecretBytes } from './secret-bytes.js';
export { InMemoryKms, LocalAwsKms, ensureMasterKey, type DataKey, type Kms } from './kms.js';
export { InMemoryKeyStore, type KeyStore, type StoredKeyRecord } from './key-store.js';
export { Ed25519Signer } from './ed25519-signer.js';
export { KmsCrypter } from './kms-crypter.js';
export {
  createCrypter,
  createSigner,
  FakeCryptoForbiddenError,
  type CrypterConfig,
  type SignerConfig,
} from './factory.js';
