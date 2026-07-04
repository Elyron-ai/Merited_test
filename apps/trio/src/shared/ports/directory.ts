import { Approval, Mandate } from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import type { Signer } from '@merited/signing';

export const PLATFORM_ATTESTATION_KEY = 'platform/attestations';

/**
 * TrioDirectory port (TRIO-7, §7.2 stage 6): how verification looks up
 * approvals and mandates. Phase 0 ships the fixture fake; PH1's TRIO-17
 * swaps in the HTTP client against the wallet backend — same port, and the
 * trio STILL verifies attestations before trusting anything (P3: never
 * trust monolith input unverified). Mandate status is read live on every
 * call — revocation takes effect immediately (B14).
 */
export interface TrioDirectory {
  getApproval(approvalId: string): Promise<Approval | null>;
  getMandate(mandateId: string): Promise<Mandate | null>;
}

/** Attestation payload = the record minus its attestation field. */
export const attestationPayload = (record: Record<string, unknown>): string => {
  const { attestation: _a, ...rest } = record;
  return canonicalJson(rest);
};

export const attest = async <T extends Record<string, unknown>>(
  signer: Signer,
  record: Omit<T, 'attestation'>,
): Promise<T> =>
  ({
    ...record,
    attestation: await signer.sign(PLATFORM_ATTESTATION_KEY, attestationPayload(record)),
  }) as unknown as T;

/**
 * Verifying wrapper — the ONLY view of the directory the pipeline uses.
 * A record whose attestation fails verification is treated as absent
 * (→ APPROVAL_MISSING / MANDATE_REVOKED downstream, never trusted).
 */
export class VerifiedDirectory implements TrioDirectory {
  constructor(
    private readonly inner: TrioDirectory,
    private readonly signer: Signer,
  ) {}

  private async check<T extends { attestation: string }>(record: T | null): Promise<T | null> {
    if (!record) return null;
    const valid = await this.signer.verify(
      PLATFORM_ATTESTATION_KEY,
      attestationPayload(record),
      record.attestation,
    );
    return valid ? record : null;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.check(await this.inner.getApproval(approvalId));
  }

  async getMandate(mandateId: string): Promise<Mandate | null> {
    return this.check(await this.inner.getMandate(mandateId));
  }
}

/** Fixture-seeded fake (Phase 0) — mutable so tests can revoke live. */
export class FixtureDirectory implements TrioDirectory {
  private approvals = new Map<string, Approval>();
  private mandates = new Map<string, Mandate>();

  setApproval(approval: Approval): void {
    this.approvals.set(approval.approval_id, Approval.parse(approval));
  }
  setMandate(mandate: Mandate): void {
    this.mandates.set(mandate.mandate_id, Mandate.parse(mandate));
  }
  /** Live revocation: next lookup sees the revoked status immediately. */
  revokeMandate(mandateId: string): void {
    const mandate = this.mandates.get(mandateId);
    if (mandate) this.mandates.set(mandateId, { ...mandate, status: 'revoked' });
  }

  getApproval(approvalId: string): Promise<Approval | null> {
    return Promise.resolve(this.approvals.get(approvalId) ?? null);
  }
  getMandate(mandateId: string): Promise<Mandate | null> {
    return Promise.resolve(this.mandates.get(mandateId) ?? null);
  }
}
