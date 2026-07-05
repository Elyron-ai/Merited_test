import { Ed25519Signer } from './ed25519-signer.js';
import { FakeCrypter } from './fake-crypter.js';
import { FakeSigner } from './fake-signer.js';
import { KmsCrypter } from './kms-crypter.js';
import type { KeyStore } from './key-store.js';
import type { Kms } from './kms.js';
import type { Crypter, Signer } from './signer.js';

/**
 * Env-guarded construction (PH1-30 accept: "`fake-`-tagged signatures
 * never appear outside dev/test"). The guard lives at the ONLY place a
 * FakeSigner/FakeCrypter can be configured into a deployment: asking for a
 * fake outside dev|test|demo throws at boot, before a single signature
 * exists. (The demo env is a dev alias — SYN-30's env-gating convention.)
 */
const FAKE_ENVS = new Set(['dev', 'test', 'demo']);

export class FakeCryptoForbiddenError extends Error {
  constructor(kind: string, env: string) {
    super(
      `${kind} is forbidden when MERITED_ENV=${env} — fake-tagged crypto never leaves dev/test (PH1-30, SYN-32)`,
    );
    this.name = 'FakeCryptoForbiddenError';
  }
}

export type SignerConfig =
  | { kind: 'fake'; env: string; secret: string }
  | { kind: 'ed25519'; kms: Kms; store: KeyStore };

export const createSigner = (config: SignerConfig): Signer => {
  if (config.kind === 'fake') {
    if (!FAKE_ENVS.has(config.env)) throw new FakeCryptoForbiddenError('FakeSigner', config.env);
    return new FakeSigner(config.secret);
  }
  return new Ed25519Signer(config.kms, config.store);
};

export type CrypterConfig =
  | { kind: 'fake'; env: string; secret: string }
  | { kind: 'kms'; kms: Kms };

export const createCrypter = (config: CrypterConfig): Crypter => {
  if (config.kind === 'fake') {
    if (!FAKE_ENVS.has(config.env)) throw new FakeCryptoForbiddenError('FakeCrypter', config.env);
    return new FakeCrypter(config.secret);
  }
  return new KmsCrypter(config.kms);
};
