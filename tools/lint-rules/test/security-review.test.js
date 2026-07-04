import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checklistSatisfied, run } from '../../ci/check-security-review.mjs';
import { HIGH_SCRUTINY_ZONES, touchesHighScrutinyZone } from '../../ci/high-scrutiny-zones.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8');

const TICKED = `## Security self-review

- [x] Inputs validated at every new or changed boundary
- [x] Signatures verified before trust — never after use
- [x] Secrets and keys never logged, serialised or persisted in plaintext
- [x] Replay/idempotency considered (and tested where behaviour changed)
`;

describe('high-scrutiny zone enforcement (XC-3, table XC.7)', () => {
  it('the zone table matches XC.7 — trio, signing, contracts, events, token-client, adapters, linking, mandates', () => {
    expect(touchesHighScrutinyZone(['apps/trio/src/verification/simulator.ts'])).toHaveLength(1);
    expect(touchesHighScrutinyZone(['apps/valet/src/reducer.ts', 'docs/build-log.md'])).toEqual([]);
    for (const zone of HIGH_SCRUTINY_ZONES) {
      expect(touchesHighScrutinyZone([`${zone}anything.ts`])).toHaveLength(1);
    }
  });

  it('a completed checklist satisfies; an unticked box or a deleted section fails', () => {
    expect(checklistSatisfied(TICKED)).toBe(true);
    expect(checklistSatisfied(TICKED.replace('- [x] Replay', '- [ ] Replay'))).toBe(false);
    expect(checklistSatisfied('## What & why\nstuff')).toBe(false);
    expect(checklistSatisfied('## Security self-review\n\n(section gutted)\n')).toBe(false);
    expect(checklistSatisfied('')).toBe(false);
  });

  it('boxes ticked in a LATER section do not satisfy the security section', () => {
    const body = `## Security self-review\n\n- [ ] Inputs validated\n\n## Checks\n\n- [x] lint green\n`;
    expect(checklistSatisfied(body)).toBe(false);
  });

  it('run(): zone diff + incomplete checklist fails; non-zone diff passes with any body', () => {
    const quiet = { log: () => {}, fail: () => {} };
    expect(run({ changedFiles: ['apps/trio/src/x.ts'], body: '', ...quiet })).toBe(1);
    expect(run({ changedFiles: ['apps/trio/src/x.ts'], body: TICKED, ...quiet })).toBe(0);
    expect(run({ changedFiles: ['docs/notes.md'], body: '', ...quiet })).toBe(0);
  });

  it('CODEOWNERS and labeler.yml carry every zone — the three sources stay in lockstep', () => {
    const codeowners = read('.github', 'CODEOWNERS');
    const labeler = read('.github', 'labeler.yml');
    for (const zone of HIGH_SCRUTINY_ZONES) {
      expect(codeowners).toContain(zone);
      expect(labeler).toContain(`'${zone}**'`);
    }
  });

  it('the PR template carries the section CI enforces, and ci.yml runs the check on PRs', () => {
    expect(read('.github', 'PULL_REQUEST_TEMPLATE.md')).toContain('## Security self-review');
    const ci = read('.github', 'workflows', 'ci.yml');
    expect(ci).toContain('security-review:');
    expect(ci).toContain('check-security-review.mjs');
    expect(read('.github', 'workflows', 'label-high-scrutiny.yml')).toContain('labeler');
  });
});
