import { pence, type MerchantCommercial } from '@merited/contracts';
import { FakeCrypter } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import * as merchantsModule from './index.js';
import { MerchantsService } from './service.js';
import { TrioKeysClient } from './trio-keys-client.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_mer_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'merchants-test';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let service: MerchantsService;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: pence(60000) },
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 'trio-test-secret',
  });
  const trioUrl = await trio.listen();
  service = new MerchantsService(
    pool,
    new FakeCrypter('merchants-test-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('merchants module (MER-2 accept)', () => {
  it('CRUD: create derives a unique slug, validates commercial config, updates and suspends', async () => {
    const first = await service.create({ name: 'Aurora Experiences', commercial });
    expect(first.slug).toBe('aurora-experiences');
    expect(first.status).toBe('active');
    expect(first.signing_key_ref).toBeNull();
    expect(first.commercial).toEqual(commercial);

    const second = await service.create({ name: 'Aurora Experiences!', commercial });
    expect(second.slug).toBe('aurora-experiences-2'); // uniquified

    const renamed = await service.update(first.merchant_id, { name: 'Aurora Spa Group' });
    expect(renamed.name).toBe('Aurora Spa Group');
    expect(renamed.slug).toBe('aurora-experiences'); // slug is stable once minted

    const suspended = await service.update(first.merchant_id, { status: 'suspended' });
    expect(suspended.status).toBe('suspended');

    expect(await service.getBySlug('aurora-experiences-2')).toEqual(second);
    expect((await service.list()).length).toBeGreaterThanOrEqual(2);
    await expect(service.get('mer_00000000000000000000000000')).rejects.toMatchObject({
      code: 'MERCHANT_NOT_FOUND',
    });
    await expect(
      service.create({ name: 'Bad BPS', commercial: { ...commercial, take_rate_bps: 20.5 } }),
    ).rejects.toThrow(); // floats never cross the boundary
  });

  it('webhook secrets: plaintext exactly once, encrypted at rest, graceful rotation', async () => {
    const merchant = await service.create({ name: 'Secret Shop', commercial });
    const issued = await service.issueWebhookSecret(merchant.merchant_id);
    expect(issued.secret).toMatch(/^whsec_/);
    expect(issued.secret_last4).toBe(issued.secret.slice(-4));

    const { rows } = await pool.query(
      `SELECT secret_ciphertext, secret_last4 FROM core.merchant_webhook_secrets WHERE secret_id = $1`,
      [issued.secret_id],
    );
    expect(rows[0].secret_ciphertext).not.toBe(issued.secret);
    expect(rows[0].secret_ciphertext).not.toContain(issued.secret); // never stored in clear (SYN-39)

    // rotation: both live until the old one is revoked
    const rotated = await service.issueWebhookSecret(merchant.merchant_id);
    expect(await service.activeWebhookSecrets(merchant.merchant_id)).toEqual([
      issued.secret,
      rotated.secret,
    ]);
    await service.revokeWebhookSecret(issued.secret_id);
    expect(await service.activeWebhookSecrets(merchant.merchant_id)).toEqual([rotated.secret]);
  });

  it('API keys: hashed at rest, authenticate live, revocation and suspension respected', async () => {
    const merchant = await service.create({ name: 'Keyed Shop', commercial });
    const { api_key } = await service.issueApiKey(merchant.merchant_id);
    expect(api_key).toMatch(/^mmk_/);
    expect(await service.authenticate(api_key)).toBe(merchant.merchant_id);
    expect(await service.authenticate('mmk_wrong')).toBeNull();

    await service.update(merchant.merchant_id, { status: 'suspended' });
    expect(await service.authenticate(api_key)).toBeNull(); // suspension bites immediately
  });

  it('keypair issuance returns public key + signing_key_ref via the trio (SYN-22)', async () => {
    const merchant = await service.create({ name: 'Signing Shop', commercial });
    const issued = await service.requestSigningKey(merchant.merchant_id);
    expect(issued.signing_key_ref).toBe(`merchant/${merchant.merchant_id}`);
    expect(issued.public_key.length).toBeGreaterThan(0);

    const refreshed = await service.get(merchant.merchant_id);
    expect(refreshed.signing_key_ref).toBe(issued.signing_key_ref);
    const { rows } = await pool.query(
      `SELECT signing_key_ref, public_key FROM core.merchant_signing_keys WHERE merchant_id = $1`,
      [merchant.merchant_id],
    );
    expect(rows).toEqual([{ signing_key_ref: issued.signing_key_ref, public_key: issued.public_key }]);
  });

  it('private key material is unreachable: exported surface and schema carry no private columns', async () => {
    // module surface: nothing exports or names private-key material
    const surface = Object.keys(merchantsModule).join(' ');
    expect(surface).not.toMatch(/private/i);

    // schema: no column in any merchants table can hold private material
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name LIKE 'merchant%'`,
    );
    for (const row of rows) {
      expect(`${row.table_name}.${row.column_name}`).not.toMatch(/private|secret_key|keypair/i);
    }
    // and the signing-keys table stores exactly reference + public half
    const signingCols = rows.filter((r) => r.table_name === 'merchant_signing_keys').map((r) => r.column_name).sort();
    expect(signingCols).toEqual(['created_at', 'merchant_id', 'public_key', 'ref_id', 'revoked_at', 'signing_key_ref']);
  });
});
