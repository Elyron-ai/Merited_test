// FND-16 job 6 (hygiene): the D8 migration checksum guard, standalone.
// Editing an APPLIED migration file must red the build — additions record
// their hash via the journal flow; changed hashes are always an error.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkChecksums } from '../../packages/events/scripts/check-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packages = ['packages/events', 'apps/core', 'apps/trio', 'apps/valet', 'apps/wallet'];

let failed = false;
for (const pkg of packages) {
  const problems = checkChecksums(path.join(root, pkg));
  if (problems.length > 0) {
    failed = true;
    console.error(`${pkg}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  } else {
    console.log(`${pkg}: checksums clean`);
  }
}
process.exit(failed ? 1 : 0);
