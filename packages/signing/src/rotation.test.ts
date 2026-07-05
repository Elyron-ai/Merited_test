import { describe, expect, it } from 'vitest';
import { Ed25519Signer } from './ed25519-signer.js';
import { InMemoryKeyStore } from './key-store.js';
import { InMemoryKms } from './kms.js';

/**
 * PH1-22: rotation tolerance at the signer. Artefacts signed under key N
 * verify after rotation to N+1 (no format change); a REVOKED version's
 * signatures stop verifying (the compromise path); the key-id convention is
 * content-derived and moves on rotation.
 */
const REF = 'platform/mint';

const fresh = () => {
  const store = new InMemoryKeyStore();
  return { store, signer: new Ed25519Signer(new InMemoryKms(), store) };
};

describe('key rotation (PH1-22)', () => {
  it('a signature made under key N verifies after rotation to N+1; new signatures use N+1', async () => {
    const { store, signer } = fresh();
    const sigV1 = await signer.sign(REF, 'minted-under-v1');
    const v1 = (await store.load(REF))!.key_id;

    const { key_id: v2 } = await signer.rotateKey(REF);
    expect(v2).not.toBe(v1); // content-derived key id moved

    // old artefact still verifies (rotation is non-breaking)…
    expect(await signer.verify(REF, 'minted-under-v1', sigV1)).toBe(true);
    // …and new signatures come from the NEW version
    const sigV2 = await signer.sign(REF, 'minted-under-v2');
    expect(await signer.verify(REF, 'minted-under-v2', sigV2)).toBe(true);
    expect((await store.load(REF))!.key_id).toBe(v2);
    // both versions live side by side in the store
    expect((await store.loadVersions(REF)).map((r) => r.key_id)).toEqual([v2, v1]);
  });

  it('COMPROMISE PATH: revoking version N makes its signatures fail; N+1 is unaffected', async () => {
    const { store, signer } = fresh();
    const sigV1 = await signer.sign(REF, 'payload');
    const v1 = (await store.load(REF))!.key_id;
    await signer.rotateKey(REF);
    const sigV2 = await signer.sign(REF, 'payload');

    expect(await signer.verify(REF, 'payload', sigV1)).toBe(true); // pre-revocation
    expect(await signer.revokeKeyVersion(REF, v1)).toBe(true);
    expect(await signer.verify(REF, 'payload', sigV1)).toBe(false); // dead immediately
    expect(await signer.verify(REF, 'payload', sigV2)).toBe(true); // current unaffected
    // revocation is idempotent
    expect(await signer.revokeKeyVersion(REF, v1)).toBe(false);
  });

  it('a SECOND signer instance over the same store verifies old and new artefacts (no in-memory coupling)', async () => {
    const { store, signer } = fresh();
    const sigV1 = await signer.sign(REF, 'cross-instance');
    await signer.rotateKey(REF);
    const sigV2 = await signer.sign(REF, 'cross-instance');

    const other = new Ed25519Signer(new InMemoryKms(), store);
    expect(await other.verify(REF, 'cross-instance', sigV1)).toBe(true);
    expect(await other.verify(REF, 'cross-instance', sigV2)).toBe(true);
  });

  it('rotation on one ref never affects another hierarchy (SYN-1 stands)', async () => {
    const { signer } = fresh();
    const merchantSig = await signer.sign('merchant/mer_1', 'cross-hierarchy');
    await signer.rotateKey(REF);
    expect(await signer.verify('merchant/mer_1', 'cross-hierarchy', merchantSig)).toBe(true);
    expect(await signer.verify(REF, 'cross-hierarchy', merchantSig)).toBe(false);
  });

  it('getPublicKey follows the current version across a rotation', async () => {
    const { signer } = fresh();
    const before = await signer.getPublicKey(REF);
    await signer.rotateKey(REF);
    const after = await signer.getPublicKey(REF);
    expect(after).not.toBe(before);
  });
});
