import { describe, expect, it } from 'vitest';
import { Ed25519Signer } from './ed25519-signer.js';
import { InMemoryKeyStore } from './key-store.js';
import { KmsCrypter } from './kms-crypter.js';
import { ensureMasterKey, LocalAwsKms } from './kms.js';

/**
 * PH1-30 against the REAL local KMS (the compose `fake-kms` container —
 * nsmithuk/local-kms speaking the AWS KMS JSON protocol). This is the
 * stub-creds posture: a real KMS wire protocol with a local endpoint;
 * production swaps the endpoint + SDK auth, never this code path's shape.
 */
const KMS_URL = process.env['MERITED_KMS_URL'] ?? 'http://localhost:4599';

describe('LocalAwsKms integration (compose fake-kms)', () => {
  it('data keys round-trip through the KMS wire protocol', async () => {
    const keyId = await ensureMasterKey(KMS_URL);
    const kms = new LocalAwsKms({ baseUrl: KMS_URL, keyId });
    const dataKey = await kms.generateDataKey();
    const plaintext = dataKey.plaintext.use((b) => Buffer.from(b));
    expect(plaintext).toHaveLength(32);
    const reopened = await kms.decryptDataKey(dataKey.ciphertextBlob);
    expect(reopened.use((b) => b.equals(plaintext))).toBe(true);
  });

  it('the full custody chain works over the wire: sign, cold-cache verify, crypter round-trip', async () => {
    const keyId = await ensureMasterKey(KMS_URL);
    const kms = new LocalAwsKms({ baseUrl: KMS_URL, keyId });
    const store = new InMemoryKeyStore();
    const signer = new Ed25519Signer(kms, store);
    const sig = await signer.sign('platform/mint', 'canonical-claims');
    const cold = new Ed25519Signer(kms, store);
    expect(await cold.verify('platform/mint', 'canonical-claims', sig)).toBe(true);

    const crypter = new KmsCrypter(kms);
    const sealed = await crypter.encrypt('platform/link_tokens', 'token-material');
    expect(await crypter.decrypt('platform/link_tokens', sealed)).toBe('token-material');
  });
});
