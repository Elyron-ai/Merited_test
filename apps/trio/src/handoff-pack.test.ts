import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '..', '..');

/**
 * TRIO-16 accept, kept honest in CI: a reader must be able to state, from
 * the pack alone, exactly which files get replaced and which suite must
 * pass. If the seam moves (a simulator renamed, the suite command changed)
 * and the pack is not updated, this fails before the pack can mislead the
 * Phase 1 implementer or the LEAD-5 auditor.
 */
describe('implementation & audit pack (TRIO-16)', () => {
  const handoff = readFileSync(path.join(appRoot, 'HANDOFF.md'), 'utf8');
  const threats = readFileSync(path.join(repoRoot, 'docs', 'trio-threat-notes.md'), 'utf8');

  it('names exactly the three replacement files, and they exist', () => {
    for (const file of [
      'src/commitment/simulator.ts',
      'src/verification/simulator.ts',
      'src/settlement/simulator.ts',
    ]) {
      expect(handoff).toContain(`\`${file}\``);
      expect(existsSync(path.join(appRoot, file))).toBe(true);
    }
  });

  it('names the token-format seam: the codec is the only format-aware code (post-PH1-25)', () => {
    expect(handoff).toContain('token-codec.ts');
    expect(handoff).toContain('v4.public.fake.');
    const codec = readFileSync(path.join(appRoot, 'src/verification/token-codec.ts'), 'utf8');
    expect(codec).toContain('v4.public.fake.'); // the fake format lives ONLY here now
    const pipeline = readFileSync(path.join(appRoot, 'src/verification/verify-pipeline.ts'), 'utf8');
    expect(pipeline).not.toContain('v4.public.fake.'); // the fenced block really moved
  });

  it('states the acceptance gate: the frozen contract suite command and the zero-edit rule', () => {
    expect(handoff).toContain('pnpm trio:contract-test');
    expect(handoff).toContain('TRIO_TARGET_URL');
    expect(handoff).toContain('zero-edit');
    expect(handoff).toContain('42');
  });

  it('names the retained modules and the key-custody requirements', () => {
    for (const retained of ['replay-store.ts', 'posting.ts', 'statements.ts']) {
      expect(handoff).toContain(retained);
    }
    for (const requirement of ['v4.public', 'Ed25519', 'KMS', 'never hand-rolled']) {
      expect(handoff).toContain(requirement);
    }
  });

  it('threat notes cover the five demanded analyses', () => {
    for (const heading of [
      'Replay races',
      'Algorithm confusion',
      'Monolith-compromise blast radius',
      'Merchant under-reporting',
      'Custodied-key handover',
    ]) {
      expect(threats).toContain(heading);
    }
  });

  it('inherits the decision register rows the task names', () => {
    for (const syn of ['SYN-8', 'SYN-9', 'SYN-10', 'SYN-11', 'SYN-12', 'SYN-22', 'SYN-32']) {
      expect(handoff).toContain(syn);
    }
  });
});
