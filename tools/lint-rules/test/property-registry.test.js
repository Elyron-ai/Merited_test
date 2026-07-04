import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const registry = readFileSync(path.join(repoRoot, 'docs', 'testing', 'property-registry.md'), 'utf8');

/** XC-6 accept: the registry lists P-1..P-8 with file links — and the
 * links must be real files, so a moved suite drags the registry with it. */
describe('property-test registry (XC-6)', () => {
  it('lists P-1 through P-8', () => {
    for (let i = 1; i <= 8; i += 1) {
      expect(registry).toMatch(new RegExp(`\\| P-${i} \\|`));
    }
  });

  it('every referenced test file exists', () => {
    const files = [...registry.matchAll(/`((?:apps|packages)\/[^`]+\.test\.ts)`/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
    }
  });

  it('the arbitraries module it points at exists and exports the P-1 generator', () => {
    const arbitraries = readFileSync(
      path.join(repoRoot, 'packages', 'contracts', 'src', 'testing', 'arbitraries.ts'),
      'utf8',
    );
    expect(arbitraries).toContain('export const arbMechanics');
    expect(arbitraries).toContain('export const mechanicsArbitraries');
  });
});
