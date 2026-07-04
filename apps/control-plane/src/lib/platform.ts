import { MerchantsService, TrioKeysClient } from '@merited/core';
import { FakeCrypter } from '@merited/signing';
import { getPool } from './db';

/**
 * The control plane drives MER-2's merchants module DIRECTLY (§5.7: a thin
 * first-party admin tool over the same database — hand-onboarding, no
 * self-serve). The crypter secret MUST match the core deployment's so the
 * adapter can decrypt webhook secrets this UI issues; the trio URL points
 * at the running simulators.
 */
let service: MerchantsService | null = null;

export const getMerchantsService = (): MerchantsService => {
  if (!service) {
    const signerSecret = process.env['MERITED_SIGNER_SECRET'] ?? 'trio-dev-secret';
    service = new MerchantsService(
      getPool(),
      new FakeCrypter(`${signerSecret}-crypter`),
      new TrioKeysClient({
        baseUrl: process.env['MERITED_TRIO_URL'] ?? 'http://localhost:4500',
        serviceToken: process.env['MERITED_TRIO_SERVICE_TOKEN'] ?? 'dev-service-token',
      }),
    );
  }
  return service;
};

/** Integer-only form parsing: bps and pence NEVER pass through floats. */
export const intField = (form: FormData, name: string): number => {
  const raw = String(form.get(name) ?? '').trim();
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be a whole number (integer pence or bps)`);
  return Number.parseInt(raw, 10);
};
