import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const register = readFileSync(path.join(repoRoot, 'docs', 'risk-register.md'), 'utf8');

/** XC-10 accept: exists; owners assigned; first review date set. */
describe('risk register (XC-10)', () => {
  it('carries all twelve seeded risks, each with an owner', () => {
    for (let i = 1; i <= 12; i += 1) {
      const row = register.split('\n').find((line) => line.startsWith(`| R${i} |`));
      expect(row, `R${i}`).toBeDefined();
      expect(row, `R${i} owner`).toMatch(/Founder|Builder|Auditor/);
    }
  });

  it('sets the next review date and the fortnightly ritual', () => {
    expect(register).toMatch(/\*\*Next review: \d{4}-\d{2}-\d{2}\*\*/);
    expect(register).toContain('fortnightly');
    expect(register).toContain('## Review log');
  });
});
