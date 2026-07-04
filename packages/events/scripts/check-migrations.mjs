// Migration checksum guard (FND-9, D8): editing an applied migration file
// fails the build. checksums.json is updated only via --update when ADDING
// new migrations; changed hashes for existing files are always an error.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function computeChecksums(pkgRoot) {
  const dir = path.join(pkgRoot, 'drizzle');
  if (!existsSync(dir)) return {};
  const out = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out[file] = createHash('sha256')
      .update(readFileSync(path.join(dir, file)))
      .digest('hex');
  }
  return out;
}

export function checkChecksums(pkgRoot) {
  const lockPath = path.join(pkgRoot, 'drizzle', 'checksums.json');
  const actual = computeChecksums(pkgRoot);
  const recorded = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
  const problems = [];
  for (const [file, hash] of Object.entries(recorded)) {
    if (!(file in actual)) problems.push(`${file}: recorded in checksums.json but missing`);
    else if (actual[file] !== hash) problems.push(`${file}: modified after being applied (forward-only, D8)`);
  }
  for (const file of Object.keys(actual)) {
    if (!(file in recorded)) problems.push(`${file}: not in checksums.json — run db:check --update`);
  }
  return problems;
}

export function updateChecksums(pkgRoot) {
  const lockPath = path.join(pkgRoot, 'drizzle', 'checksums.json');
  const actual = computeChecksums(pkgRoot);
  const recorded = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
  for (const [file, hash] of Object.entries(recorded)) {
    if (file in actual && actual[file] !== hash) {
      throw new Error(`${file}: refusing to update checksum of a modified applied migration`);
    }
  }
  writeFileSync(lockPath, JSON.stringify(actual, null, 2) + '\n');
  return Object.keys(actual);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--update')) {
    console.log(`checksums recorded for: ${updateChecksums(pkgRoot).join(', ')}`);
  } else {
    const problems = checkChecksums(pkgRoot);
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log('migration checksums ok');
  }
}
