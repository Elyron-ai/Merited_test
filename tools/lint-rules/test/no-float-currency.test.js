import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../no-float-currency.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const lint = (code, filename = 'apps/core/src/anywhere.ts') => {
  const linter = new Linter({ cwd: repoRoot });
  return linter.verify(
    code,
    {
      plugins: { merited: { rules: { 'no-float-currency': rule } } },
      rules: { 'merited/no-float-currency': 'error' },
      files: ['**/*.ts', '**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    path.join(repoRoot, filename),
  );
};

describe('no-float-currency (XC-2, §0: money is integer pence)', () => {
  it('a float reaching pence() fails', () => {
    expect(lint('pence(84.5);')).toHaveLength(1);
    expect(lint('pence(-84.5);')).toHaveLength(1); // unary minus unwrapped
    expect(lint('pence(8450);')).toEqual([]);
  });

  it('a float in a monetary property fails — bps, pence, x100 and amount keys', () => {
    expect(lint('const c = { take_rate_bps: 20.5 };')).toHaveLength(1);
    expect(lint('const o = { gross_pence: 84.5 };')).toHaveLength(1);
    expect(lint('const m = { amount: 12.99 };')).toHaveLength(1);
    expect(lint('const c = { take_rate_bps: 2050 };')).toEqual([]);
  });

  it('monetary variables and assignments are covered', () => {
    expect(lint('const bounty_pence = 12.5;')).toHaveLength(1);
    expect(lint('let x = {}; x.budget_pence = 0.5;')).toHaveLength(1);
    expect(lint('const bounty_pence = 1250;')).toEqual([]);
  });

  it('parseFloat feeding a money position fails — integer parsers only', () => {
    expect(lint("const gross_pence = parseFloat(input);")).toHaveLength(1);
    expect(lint("const c = { take_rate_bps: Number.parseFloat(raw) };")).toHaveLength(1);
    expect(lint("const gross_pence = Number.parseInt(input, 10);")).toEqual([]);
  });

  it('non-monetary decimals stay legal — this is not a blanket decimal ban', () => {
    expect(lint('const paceMs = 0.5; const ratio = 2.5;')).toEqual([]);
    expect(lint('setTimeout(fn, 1.5 * 1000);')).toEqual([]);
  });

  it('floats hiding behind ?? and ternaries are still caught', () => {
    expect(lint('const c = { amount: flag ? 12.5 : 13 };')).toHaveLength(1);
    expect(lint('const budget_pence = input ?? 9.99;')).toHaveLength(1);
  });

  it('test files are exempt — negative fixtures must write illegal payloads', () => {
    expect(lint('pence(84.5);', 'packages/contracts/src/money.test.ts')).toEqual([]);
  });

  it('CI-level: a float bounty in production code fails the repo lint', () => {
    const fixtureDir = mkdtempSync(path.join(repoRoot, 'apps', 'core', 'src', 'xc2-float-fixture-'));
    const fixture = path.join(fixtureDir, 'illegal.ts');
    writeFileSync(fixture, 'export const bad = { take_rate_bps: 20.5 };\n');
    try {
      let failed = false;
      try {
        execSync(`pnpm exec eslint --no-warn-ignored ${JSON.stringify(fixture)}`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (error) {
        failed = true;
        expect(String(error.stdout ?? '')).toContain('merited/no-float-currency');
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
