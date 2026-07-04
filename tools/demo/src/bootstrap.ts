import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../apps/core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../../../apps/valet/scripts/migrate.mjs';

/**
 * Clean-machine bootstrap (VAL-15, §9 gate): zero manual steps between
 * `git clone` and a completed Act 1. Preflight with actionable UK-English
 * messages → compose up → all migrations → the demo. `MERITED_DEMO_MODE=ci`
 * runs the same act fast and bare (the clean-machine CI job uses it).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface PreflightProbes {
  nodeVersion?: string;
  commandOk?(command: string): boolean;
}

export interface PreflightFailure {
  what: string;
  fix: string;
}

const defaultCommandOk = (command: string): boolean => {
  try {
    execSync(command, { stdio: 'pipe', cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
};

/** Pure-ish and injectable so the failure messages are unit-testable. */
export const preflight = (probes: PreflightProbes = {}): PreflightFailure[] => {
  const nodeVersion = probes.nodeVersion ?? process.versions.node;
  const commandOk = probes.commandOk ?? defaultCommandOk;
  const failures: PreflightFailure[] = [];

  if (Number.parseInt(nodeVersion.split('.')[0]!, 10) < 22) {
    failures.push({
      what: `Node ${nodeVersion} is too old — Merited needs Node 22 or newer.`,
      fix: 'Install it with nvm (an .nvmrc is provided): nvm install && nvm use',
    });
  }
  if (!commandOk('pnpm --version')) {
    failures.push({
      what: 'pnpm is not available on your PATH.',
      fix: 'Enable it through corepack (ships with Node): corepack enable',
    });
  }
  if (!commandOk('docker info')) {
    failures.push({
      what: 'The Docker daemon is not running (or Docker is not installed).',
      fix: 'Start Docker Desktop, wait for it to settle, then run pnpm demo:act1 again.',
    });
  }
  if (!existsSync(path.join(repoRoot, 'docker-compose.yml'))) {
    failures.push({
      what: 'docker-compose.yml is missing — this does not look like a full checkout.',
      fix: 'Clone the repository afresh and run from its root.',
    });
  }
  return failures;
};

export const bootstrap = async (): Promise<void> => {
  const print = (line: string) => console.log(line);

  const failures = preflight();
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`✗ ${failure.what}`);
      console.error(`  → ${failure.fix}`);
    }
    process.exitCode = 1;
    return;
  }

  print('Starting the local platform (Postgres, Redis, fake KMS, Mailpit)…');
  try {
    execSync('docker compose up -d --wait postgres redis fake-kms mailpit', {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('✗ docker compose could not start the platform containers.');
    console.error('  → If another Postgres is already using port 5432, stop it first,');
    console.error('    then run pnpm demo:act1 again. Compose said:');
    console.error(String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 400));
    process.exitCode = 1;
    return;
  }

  print('Building the workspace (first run takes a minute)…');
  try {
    execSync('pnpm -r build', { cwd: repoRoot, stdio: 'pipe' });
  } catch (error) {
    console.error('✗ The workspace build failed. Full output:');
    console.error(String((error as { stdout?: Buffer }).stdout ?? error).slice(-2000));
    process.exitCode = 1;
    return;
  }

  print('Applying database migrations…');
  await migrate();
  await migrateCore();
  await migrateTrio();
  await migrateValet();

  const mode = process.env['MERITED_DEMO_MODE'] === 'ci' ? ('ci' as const) : ('human' as const);
  print(mode === 'human' ? 'Running Act 1 — the walletless conversion loop.\n' : 'Running Act 1 (CI mode).');
  // dynamic: act1's import chain reaches workspace dist files, which exist
  // only AFTER the build step above ran (bare-checkout ordering)
  const { runAct1 } = await import('./act1.js');
  const result = await runAct1({ mode, ...(mode === 'human' ? { paceMs: 600 } : {}) });

  print('');
  print(`Act 1 complete: ${result.steps} steps.`);
  print('Artefacts:');
  for (const artefact of result.artefacts) print(`  ${artefact}`);
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  bootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
