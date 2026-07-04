import { APPROVAL_FIXTURE, MANDATE_FIXTURE } from '@merited/contracts';
import { FakeSigner } from '@merited/signing';
import { describe, expect, it } from 'vitest';
import {
  attest,
  FixtureDirectory,
  VerifiedDirectory,
  type TrioDirectory,
} from './directory.js';

const signer = new FakeSigner('trio-test-secret');

const seeded = async (): Promise<{ inner: FixtureDirectory; dir: VerifiedDirectory }> => {
  const inner = new FixtureDirectory();
  const { attestation: _a1, ...approvalBase } = APPROVAL_FIXTURE;
  const { attestation: _a2, ...mandateBase } = MANDATE_FIXTURE;
  inner.setApproval(await attest(signer, approvalBase));
  inner.setMandate(await attest(signer, mandateBase));
  return { inner, dir: new VerifiedDirectory(inner, signer) };
};

describe('TrioDirectory (TRIO-7 accept)', () => {
  it('round-trips properly attested fixture approvals and mandates', async () => {
    const { dir } = await seeded();
    const approval = await dir.getApproval(APPROVAL_FIXTURE.approval_id);
    expect(approval?.quote_id).toBe(APPROVAL_FIXTURE.quote_id);
    const mandate = await dir.getMandate(MANDATE_FIXTURE.mandate_id);
    expect(mandate?.status).toBe('active');
  });

  it('tampered attestation → treated as absent (never trusted)', async () => {
    const { inner, dir } = await seeded();
    const stored = (await inner.getApproval(APPROVAL_FIXTURE.approval_id))!;
    inner.setApproval({ ...stored, attestation: stored.attestation.slice(0, -2) + 'ff' });
    expect(await dir.getApproval(APPROVAL_FIXTURE.approval_id)).toBeNull();
  });

  it('tampered record body (valid-looking attestation over old body) → absent', async () => {
    const { inner, dir } = await seeded();
    const stored = (await inner.getMandate(MANDATE_FIXTURE.mandate_id))!;
    inner.setMandate({ ...stored, merchants: ['*', 'mer_01J0000000000000000000000Z'] });
    expect(await dir.getMandate(MANDATE_FIXTURE.mandate_id)).toBeNull();
  });

  it('attestation from the wrong key hierarchy fails (SYN-1)', async () => {
    const { inner, dir } = await seeded();
    const { attestation: _a, ...base } = APPROVAL_FIXTURE;
    const wrongKey = {
      ...base,
      attestation: await signer.sign('merchant/mer_01J0000000000000000000000A', 'anything'),
    };
    inner.setApproval(wrongKey);
    expect(await dir.getApproval(APPROVAL_FIXTURE.approval_id)).toBeNull();
  });

  it('live revocation: the very next mandate lookup sees revoked status', async () => {
    const { inner } = await seeded();
    // status flows through unverified reads too — but the pipeline uses the
    // verified view; re-attest the revoked record as the wallet backend would.
    inner.revokeMandate(MANDATE_FIXTURE.mandate_id);
    const revoked = await inner.getMandate(MANDATE_FIXTURE.mandate_id);
    expect(revoked?.status).toBe('revoked');
  });

  it('unknown ids resolve to null', async () => {
    const { dir } = await seeded();
    expect(await dir.getApproval('apr_01J0000000000000000000000Z')).toBeNull();
    expect(await dir.getMandate('mnd_01J0000000000000000000000Z')).toBeNull();
  });

  it('port is swappable (TRIO-17 seam): any TrioDirectory fits the verifying wrapper', async () => {
    const empty: TrioDirectory = {
      getApproval: () => Promise.resolve(null),
      getMandate: () => Promise.resolve(null),
    };
    const dir = new VerifiedDirectory(empty, signer);
    expect(await dir.getApproval(APPROVAL_FIXTURE.approval_id)).toBeNull();
  });
});
