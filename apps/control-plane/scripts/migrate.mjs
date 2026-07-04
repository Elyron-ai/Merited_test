// Control-plane migrations — the FND-9 runner with the control_plane schema.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from '../../../packages/events/scripts/migrate.mjs';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const migrateControlPlane = (adminUrl) => migrate(adminUrl, { pkgRoot, schema: 'control_plane' });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateControlPlane()
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations (no-op)'))
    .catch((error) => { console.error(error.message); process.exit(1); });
}
