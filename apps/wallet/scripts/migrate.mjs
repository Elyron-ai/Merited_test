// Wallet migrations (PH1-8+) — the generalised FND-9 runner, wallet schema.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from '../../../packages/events/scripts/migrate.mjs';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const migrateWallet = (adminUrl) => migrate(adminUrl, { pkgRoot, schema: 'wallet' });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateWallet()
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations (no-op)'))
    .catch((error) => { console.error(error.message); process.exit(1); });
}
