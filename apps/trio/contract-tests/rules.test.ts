import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TRIO-13 harness rules, enforced statically (the CI seam guard):
 *
 *  1. Route files import only the contracts interface side — never a
 *     simulator. PH1-24…26 replace each module's simulator.ts file-for-file;
 *     a route importing one would break the swap seam.
 *  2. Contract-test files import ONLY packages and the harness — never
 *     `apps/trio/src`. Tokens stay opaque, negatives come from public
 *     inputs, and the suite survives the Phase-1 swap byte-identical.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');

const importSpecifiers = (filePath: string): string[] => {
  const source = readFileSync(filePath, 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|await import\(\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });

describe('harness rules (the file-for-file seam, statically enforced)', () => {
  it('no routes.ts imports a simulator', () => {
    const routeFiles = walk(srcRoot).filter((f) => f.endsWith('routes.ts'));
    expect(routeFiles.length).toBeGreaterThanOrEqual(3);
    for (const file of routeFiles) {
      for (const spec of importSpecifiers(file)) {
        expect(spec.includes('simulator'), `${path.relative(srcRoot, file)} imports ${spec}`).toBe(
          false,
        );
      }
    }
  });

  it('contract tests import only packages and the harness — never apps/trio/src', () => {
    const allowed = [
      /^node:/,
      /^vitest$/,
      /^@merited\/(contracts|events|signing)$/,
      /^\.\/harness\.js$/,
    ];
    const testFiles = walk(here).filter((f) => f.endsWith('.test.ts'));
    expect(testFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of testFiles) {
      for (const spec of importSpecifiers(file)) {
        expect(
          allowed.some((rule) => rule.test(spec)),
          `${path.basename(file)} imports ${spec} — outside the contract-suite allowlist`,
        ).toBe(true);
      }
    }
  });

  it('only the harness may load simulators, and only via dynamic import on the in-process branch', () => {
    const harness = readFileSync(path.join(here, 'harness.ts'), 'utf8');
    const staticImports = [...harness.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)].map(
      (m) => m[1]!,
    );
    for (const spec of staticImports) {
      expect(
        spec.startsWith('../src'),
        `harness.ts statically imports ${spec} — simulator code must stay behind the dynamic in-process branch`,
      ).toBe(false);
    }
  });
});
