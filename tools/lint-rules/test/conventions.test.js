import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

/**
 * XC-1 accept, kept honest in CI (runs in the hygiene job alongside the
 * lint-rule tests): CONTRIBUTING cites BUILD-SPEC §1's contracts rule
 * VERBATIM — asserted against the spec text itself, so a reworded spec or a
 * paraphrased citation fails here rather than drifting apart silently — and
 * the PR template lives at the path GitHub renders, with the mandatory
 * Task-ID field and the contracts-first checkbox.
 */
describe('repo conventions pack (XC-1)', () => {
  it('CONTRIBUTING cites the §1 contracts rule verbatim from BUILD-SPEC', () => {
    const spec = read('BUILD-SPEC.md');
    const rule = spec
      .split('\n')
      .find((line) => line.startsWith('Rule: ') && line.includes('packages/contracts'));
    expect(rule).toBeDefined();
    expect(read('CONTRIBUTING.md')).toContain(rule.replace(/^Rule: /, ''));
  });

  it('CONTRIBUTING states the branch-naming, UK-English and integer-pence rules', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('feat/<TASK-ID>-slug');
    expect(contributing).toContain('UK English');
    expect(contributing).toContain('integer pence');
  });

  it('the PR template renders where GitHub looks, with the mandatory fields', () => {
    const template = read('.github', 'PULL_REQUEST_TEMPLATE.md');
    expect(template).toContain('Task-ID (mandatory)');
    expect(template).toContain('TASK-ID:');
    expect(template).toContain('[ ] **Touches contracts first?**');
  });
});
