import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const decisionsDir = path.join(repoRoot, 'docs', 'decisions');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

/** XC-4 accept: D1–D8 seeded one ADR each with a status, every ADR linked
 * from BUILD-PLAN, and D1 referenced by FND-10's hash code. */
describe('decision log (XC-4, table XC.8)', () => {
  const adrs = readdirSync(decisionsDir).filter((f) => /^ADR-\d{3}-.+\.md$/.test(f));

  it('D1–D8 are seeded: ADR-001…008 all present (the log may grow beyond the seed)', () => {
    const numbers = adrs.map((f) => f.slice(0, 7));
    for (let i = 1; i <= 8; i += 1) {
      expect(numbers).toContain(`ADR-00${i}`);
    }
  });

  it('every ADR declares status accepted or deferred; D4 is the deferred one', () => {
    for (const file of adrs) {
      const body = read('docs', 'decisions', file);
      expect(body, file).toMatch(/\*\*Status:\*\* (accepted|deferred)/);
    }
    expect(read('docs', 'decisions', 'ADR-004-hosting-deferred.md')).toContain('**Status:** deferred');
  });

  it('every ADR is linked from BUILD-PLAN (the XC.8 table rows)', () => {
    const plan = read('BUILD-PLAN.md');
    for (const file of adrs) {
      expect(plan, file).toContain(`docs/decisions/${file}`);
    }
  });

  it("D1 is referenced by FND-10's hash code", () => {
    expect(read('packages', 'events', 'src', 'canonical-json.ts')).toContain(
      'docs/decisions/ADR-001-canonical-json.md',
    );
  });
});
