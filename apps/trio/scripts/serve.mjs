import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
import { migrateTrio } from './migrate.mjs';

/**
 * Standalone trio server (PH1-23): boots whatever trio implementation is in
 * the tree — the Phase-0 simulators today, the PH1-24…26/30 real services
 * after the file-for-file swap, with ZERO changes here — as an
 * out-of-process HTTP target for the dual-target contract-suite run
 * (`TRIO_TARGET=real-http` in CI) and for TRIO-17/PH1-27 integration.
 *
 * Env: TRIO_SERVE_DATABASE_URL (app-role URL; when unset a fresh throwaway
 * database is created and migrated via the compose admin), TRIO_SERVE_PORT
 * (default 4590), MERITED_TRIO_SERVICE_TOKEN, MERITED_TRIO_SIGNER_SECRET.
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const port = Number.parseInt(process.env.TRIO_SERVE_PORT ?? '4590', 10);
const serviceToken = process.env.MERITED_TRIO_SERVICE_TOKEN ?? 'trio-serve-token';
const signerSecret = process.env.MERITED_TRIO_SIGNER_SECRET ?? 'trio-test-secret';

let databaseUrl = process.env.TRIO_SERVE_DATABASE_URL;
if (!databaseUrl) {
  const dbName = `merited_serve_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await admin.end();
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  databaseUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  console.log(`serve: fresh database ${dbName} migrated (events + trio)`);
}

// Host-level Chromium resolution (the statement-PDF route), same convention
// as the contract-test harness — the trio itself takes it via options.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const chromiumProbe = spawnSync('test', ['-e', '/opt/pw-browsers/chromium']);
const chromiumPath =
  process.env.MERITED_CHROMIUM_PATH ??
  (chromiumProbe.status === 0 ? '/opt/pw-browsers/chromium' : undefined);

const { createSimulatedTrio } = await import(
  path.join(repoRoot, 'apps', 'trio', 'dist', 'testing.js')
);

// PH1-24: TRIO_CRYPTO=ed25519 boots the REAL signer — Ed25519 keys
// envelope-encrypted under the KMS (compose fake-kms locally; a real KMS
// endpoint in staging), custody rows in trio.signing_keys.
let signer;
if (process.env.TRIO_CRYPTO === 'ed25519') {
  const { Ed25519Signer, LocalAwsKms, ensureMasterKey } = await import(
    path.join(repoRoot, 'packages', 'signing', 'dist', 'index.js')
  );
  const { PgKeyStore } = await import(
    path.join(repoRoot, 'apps', 'trio', 'dist', 'shared', 'pg-key-store.js')
  );
  const kmsUrl = process.env.MERITED_KMS_URL ?? 'http://localhost:4599';
  const kmsKeyId = process.env.MERITED_KMS_KEY_ID ?? (await ensureMasterKey(kmsUrl));
  const keyPool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  keyPool.on('error', () => {});
  signer = new Ed25519Signer(new LocalAwsKms({ baseUrl: kmsUrl, keyId: kmsKeyId }), new PgKeyStore(keyPool));
  console.log('serve: crypto = REAL Ed25519 (KMS-enveloped custody)');
}

const trio = createSimulatedTrio({
  databaseUrl,
  serviceToken,
  signerSecret,
  ...(signer ? { signer } : {}),
  ...(chromiumPath ? { chromiumPath } : {}),
});
await trio.app.listen({ port, host: '127.0.0.1' });
console.log(`trio listening on http://127.0.0.1:${port} (service token: set via MERITED_TRIO_SERVICE_TOKEN)`);

const shutdown = async () => {
  await trio.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
