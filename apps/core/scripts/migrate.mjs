// Core migrations — reuses the generalised FND-9 runner with the core schema.
// No migrations exist yet (CORE-2 lands 0000); the runner no-ops cleanly.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from '../../../packages/events/scripts/migrate.mjs';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const migrateCore = (adminUrl) => migrate(adminUrl, { pkgRoot, schema: 'core' });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateCore()
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations (no-op)'))
    .catch((error) => { console.error(error.message); process.exit(1); });
}
