// @merited/signing — Signer/Crypter interfaces + Phase-0 fakes.
// Real KMS-backed implementations are PH1-30 (SYN-32). No real crypto here.
export * from './signer.js';
export { FakeSigner } from './fake-signer.js';
export { FakeCrypter, DecryptionError } from './fake-crypter.js';
