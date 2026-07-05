import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../no-refresh-token.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const lint = (code, filename) => {
  const linter = new Linter({ cwd: repoRoot });
  return linter.verify(
    code,
    {
      plugins: { merited: { rules: { 'no-refresh-token': rule } } },
      rules: { 'merited/no-refresh-token': 'error' },
      files: ['**/*.ts', '**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    { filename: path.join(repoRoot, filename) },
  );
};

describe('no-refresh-token (FND-15 accept — §6.3 lint rule + negative fixtures)', () => {
  it('a refresh_token key in a contract schema is an error; the same key in app code (not logged) is not', () => {
    const schema = `export const Link = z.object({ refresh_token: z.string() });`;
    expect(lint(schema, 'packages/contracts/src/identity-link.ts')).toHaveLength(1);
    expect(lint(schema, 'apps/wallet/src/modules/linking/store.ts')).toHaveLength(0);
  });

  it('access tokens are banned in contracts, allowed ONLY in wallet linking internals for logger args', () => {
    const logged = `logger.info({ access_token: token });`;
    expect(lint(`const x = { access_token: 'x' };`, 'packages/contracts/src/api.ts')).toHaveLength(1);
    expect(lint(logged, 'apps/core/src/anything.ts')).toHaveLength(1);
    expect(lint(logged, 'apps/wallet/src/modules/linking/refresh.ts')).toHaveLength(0);
  });

  it('token keys in logger-call arguments are errors repo-wide, even nested', () => {
    expect(lint(`log.warn({ ctx: { refresh_token: value } }, 'oops');`, 'apps/core/src/x.ts')).toHaveLength(1);
    expect(lint(`req.log.error({ refreshToken });`, 'apps/trio/src/y.ts')).toHaveLength(1);
    // a non-logger call with the same shape is NOT the logger branch's business
    expect(lint(`store.save({ refresh_token: value });`, 'apps/wallet/src/modules/linking/save.ts')).toHaveLength(0);
  });

  it('contracts/src/ports is exempt from the strict branch (OAuth ports speak OAuth), logger checks still apply', () => {
    const port = `export const shape = { refresh_token: '', access_token: '' };`;
    expect(lint(port, 'packages/contracts/src/ports/index.ts')).toHaveLength(0);
    expect(lint(`logger.info({ refresh_token: t });`, 'packages/contracts/src/ports/index.ts')).toHaveLength(1);
  });

  it('CI-level: a fixture adding refresh_token to a REAL contract schema fails the repo lint', () => {
    const fixtureDir = mkdtempSync(path.join(repoRoot, 'packages', 'contracts', 'src', 'fnd15-fixture-'));
    const fixture = path.join(fixtureDir, 'illegal.ts');
    writeFileSync(fixture, `import { z } from 'zod';\nexport const Bad = z.object({ refresh_token: z.string() });\n`);
    try {
      let failed = false;
      try {
        execSync(`pnpm exec eslint --no-warn-ignored ${JSON.stringify(fixture)}`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (error) {
        failed = true;
        expect(String(error.stdout ?? '')).toContain('merited/no-refresh-token');
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('built contract types are clean: dist d.ts grep finds no token keys outside ports', () => {
    const distDir = path.join(repoRoot, 'packages', 'contracts', 'dist');
    expect(existsSync(distDir), 'contracts dist must be built before the hygiene grep').toBe(true);
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.d.ts') && !full.includes(`${path.sep}ports${path.sep}`)) {
          if (/refresh_?token|access_?token/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(distDir);
    expect(offenders).toEqual([]);
  });
});

describe('PH1-1 extension — response surfaces are strict like contracts', () => {
  it('a refresh_token key in a routes file or the OpenAPI document errors', () => {
    const code = `export const shape = { refresh_token: value };`;
    expect(lint(code, 'apps/wallet/src/modules/linking/routes.ts')).toHaveLength(1);
    expect(lint(code, 'apps/core/src/routes/v1/index.ts')).toHaveLength(1);
    expect(lint(code, 'apps/trio/src/openapi/document.ts')).toHaveLength(1);
    expect(lint(code, 'apps/control-plane/src/app/api/login/route.ts')).toHaveLength(1);
  });

  it('fake-aurora is exempt — the external IdP fake speaks real OAuth field names', () => {
    const code = `export const tokenResponse = { access_token: a, refresh_token: r };`;
    expect(lint(code, 'apps/fake-aurora/src/idp/routes.ts')).toHaveLength(0);
  });

  it('linking STORAGE internals (non-route files) still handle tokens; loggers still refuse', () => {
    expect(lint(`const refresh_token = decrypt(row);`, 'apps/wallet/src/modules/linking/store.ts')).toHaveLength(0);
    expect(lint(`log.info({ refresh_token });`, 'apps/wallet/src/modules/linking/store.ts')).toHaveLength(1);
  });
});
