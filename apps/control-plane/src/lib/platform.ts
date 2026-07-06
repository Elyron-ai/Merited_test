import {
  MerchantsService,
  OfferPublisher,
  OffersRepository,
  OffersService,
  TrioCommitmentsClient,
  TrioKeysClient,
} from '@merited/core';
import { FakeCrypter } from '@merited/signing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getPool } from './db';
import { secretFromEnv } from './require-secret';

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
    const signerSecret = secretFromEnv('MERITED_SIGNER_SECRET', 'trio-dev-secret');
    service = new MerchantsService(
      getPool(),
      new FakeCrypter(`${signerSecret}-crypter`),
      new TrioKeysClient({
        baseUrl: process.env['MERITED_TRIO_URL'] ?? 'http://localhost:4500',
        serviceToken: secretFromEnv('MERITED_TRIO_SERVICE_TOKEN', 'dev-service-token'),
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

let offers: { repository: OffersRepository; service: OffersService; publisher: OfferPublisher } | null = null;

/** CORE-2/5 driven directly (same first-party posture as the merchants
 * screens): publishing/bounty edits go through the publisher, which owns
 * the trio commitment call. */
export const getOffersStack = () => {
  if (!offers) {
    const pool = getPool();
    const repository = new OffersRepository(drizzle(pool));
    const publisher = new OfferPublisher({
      pool,
      repository,
      commitments: new TrioCommitmentsClient({
        baseUrl: process.env['MERITED_TRIO_URL'] ?? 'http://localhost:4500',
        serviceToken: secretFromEnv('MERITED_TRIO_SERVICE_TOKEN', 'dev-service-token'),
      }),
      merchantFor: (id) => getMerchantsService().get(id),
    });
    offers = { repository, service: new OffersService(repository), publisher };
  }
  return offers;
};
