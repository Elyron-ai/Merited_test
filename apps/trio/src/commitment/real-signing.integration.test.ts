import { createPublicKey, verify as edVerify } from 'node:crypto';
import { pence, type CommitmentDraft } from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { canonicalJson } from '@merited/events';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
import { Ed25519Signer, InMemoryKms } from '@merited/signing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../shared/clock.js';
import { PgKeyStore } from '../shared/pg-key-store.js';
import {
  CommitmentSimulator,
  MerchantKeySimulator,
  merchantSignedPayload,
  unsignedCommitmentPayload,
} from './simulator.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_realsign_${Date.now().toString(36)}`;
const ids = seededIdFactory(1924);
const merchantId = ids.next('mer');

let admin: pg.Client;
let pool: pg.Pool;
let commitments: CommitmentSimulator;
let keys: MerchantKeySimulator;

const draft: CommitmentDraft = {
  merchant_id: merchantId,
  offer_ref: ids.next('off'),
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    max_conversions: 100,
    attribution_window_s: 86400,
    clawback_window_s: 2592000,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2027-06-30T00:00:00Z',
  },
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  const signer = new Ed25519Signer(new InMemoryKms(), new PgKeyStore(pool));
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  keys = new MerchantKeySimulator(deps);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const verifyAgainstPublished = (publicKey: string, payload: string, signature: string): boolean =>
  edVerify(
    null,
    Buffer.from(payload, 'utf8'),
    createPublicKey({
      key: Buffer.from(publicKey.replace(/^ed25519-pub:/, ''), 'base64url'),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(signature.replace(/^ed25519:/, ''), 'base64url'),
  );

describe('real commitment signing (PH1-24 accept — getPublicKey round-trip)', () => {
  it('a COR countersigned by the real service verifies both signatures against the ISSUED public keys', async () => {
    const { commitment } = await commitments.create(draft);
    expect(commitment.merchant_sig.startsWith('ed25519:')).toBe(true);
    expect(commitment.platform_sig.startsWith('ed25519:')).toBe(true);

    // merchant signature ↔ the custodied key's published public half
    const issued = await keys.issueMerchantKey({ merchant_id: draft.merchant_id });
    expect(
      verifyAgainstPublished(
        issued.public_key,
        unsignedCommitmentPayload(commitment as never),
        commitment.merchant_sig,
      ),
    ).toBe(true);

    // the custodied-key SIGNING call produces signatures the same key verifies
    const signed = await keys.signForMerchant(draft.merchant_id, { payload: 'adapter-claim-payload' });
    expect(verifyAgainstPublished(issued.public_key, 'adapter-claim-payload', signed.signature)).toBe(
      true,
    );
    // and a different payload refuses
    expect(verifyAgainstPublished(issued.public_key, 'tampered', signed.signature)).toBe(false);
  });

  it('platform countersignature verifies via the platform key round-trip; a fake-tagged sig cannot', async () => {
    const { commitment } = await commitments.create({
      ...draft,
      offer_ref: ids.next('off'),
    });
    const platformKey = await (
      commitments as unknown as { deps: { signer: { getPublicKey(r: string): Promise<string> } } }
    ).deps.signer.getPublicKey('platform/commitments');
    expect(
      verifyAgainstPublished(
        platformKey,
        merchantSignedPayload(commitment as never),
        commitment.platform_sig,
      ),
    ).toBe(true);
    expect(canonicalJson(commitment)).not.toContain('fake-ed25519');
  });
});
