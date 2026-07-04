import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../no-schema-outside-contracts.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const lint = (code, filename) => {
  const linter = new Linter({ cwd: repoRoot });
  return linter.verify(
    code,
    {
      plugins: { merited: { rules: { 'no-schema-outside-contracts': rule } } },
      rules: { 'merited/no-schema-outside-contracts': 'error' },
      files: ['**/*.ts', '**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    path.join(repoRoot, filename),
  );
};

const SCHEMA = `import { z } from 'zod';\nconst Body = z.object({ name: z.string().min(1) });\nexport default Body;\n`;

describe('no-schema-outside-contracts (XC-2, §1)', () => {
  it("the Accept case: a z.object added under apps/core fails lint", () => {
    const messages = lint(SCHEMA, 'apps/core/src/modules/offers/new-schema.ts');
    expect(messages).toHaveLength(1); // outermost call only — one error per declaration
    expect(messages[0].message).toContain('packages/contracts');
  });

  it('the same declaration inside packages/contracts is the sanctioned home', () => {
    expect(lint(SCHEMA, 'packages/contracts/src/new-schema.ts')).toEqual([]);
  });

  it('a renamed zod import is still caught', () => {
    const code = `import * as zed from 'zod';\nexport const S = zed.object({ a: zed.number() });\n`;
    expect(lint(code, 'apps/valet/src/anything.ts')).toHaveLength(1);
  });

  it('each documented exemption holds: tests, fake-aurora, openapi glue, env specs', () => {
    for (const home of [
      'apps/core/src/modules/offers/offers.test.ts',
      'apps/core/test/helper.ts',
      'apps/fake-aurora/src/shop/server.ts',
      'apps/trio/src/openapi/document.ts',
      'apps/core/src/env.ts',
    ]) {
      expect(lint(SCHEMA, home)).toEqual([]);
    }
  });

  it('non-zod member calls are not confused for schemas', () => {
    const code = `const z = { object: () => 1 };\nconst x = z.object();\nconst path = { join: (a) => a };\npath.join('x');\n`;
    expect(lint(code, 'apps/core/src/somewhere.ts')).toEqual([]);
  });

  it('CI-level (the XC-2 Accept, verbatim): a z.object added under apps/core fails the repo lint', () => {
    const fixtureDir = mkdtempSync(path.join(repoRoot, 'apps', 'core', 'src', 'xc2-fixture-'));
    const fixture = path.join(fixtureDir, 'illegal.ts');
    writeFileSync(fixture, SCHEMA);
    try {
      let failed = false;
      try {
        execSync(`pnpm exec eslint --no-warn-ignored ${JSON.stringify(fixture)}`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (error) {
        failed = true;
        expect(String(error.stdout ?? '')).toContain('merited/no-schema-outside-contracts');
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
