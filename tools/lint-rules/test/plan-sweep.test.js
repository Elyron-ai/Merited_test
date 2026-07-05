import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const plan = readFileSync(path.join(repoRoot, 'BUILD-PLAN.md'), 'utf8');
const buildLog = readFileSync(path.join(repoRoot, 'docs', 'build-log.md'), 'utf8');

/** XC-11: the automated half of the weekly sweep — plan state and the
 * build log cannot drift apart between sittings. */
describe('plan maintenance (XC-11)', () => {
  const doneIds = [
    ...plan.matchAll(/^\|\s*\*{0,2}((?:FND|TRIO|CORE|MER|VAL|XC|PH\d|LEAD)-\d+)\*{0,2}[^\n]*— ✅ done/gm),
  ].map((m) => m[1]);

  it('every ✅ task row has a build-log entry naming it', () => {
    expect(doneIds.length).toBeGreaterThan(70);
    for (const id of doneIds) {
      expect(buildLog.includes(id), `${id} marked done but absent from docs/build-log.md`).toBe(true);
    }
  });

  it('every commit since the process began carries a task ID', () => {
    const subjects = execSync('git log --no-merges --format=%s', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(subjects.length).toBeGreaterThan(50);
    const isTaskCommit = (s) =>
      /^(feat|fix|chore|docs)\((?:FND|TRIO|CORE|MER|VAL|XC|PH\d|LEAD|M\d)[-0-9/+…a-z ]*\)/i.test(s);
    // newest-first: the oldest contiguous run of non-matching subjects is
    // the pre-process planning era (spec, plan, harness) — everything after
    // the first task commit must carry an ID
    let oldestTask = subjects.length - 1;
    while (oldestTask >= 0 && !isTaskCommit(subjects[oldestTask])) oldestTask -= 1;
    const sinceProcess = subjects.slice(0, oldestTask + 1);
    const offenders = sinceProcess.filter((s) => !isTaskCommit(s));
    expect(offenders).toEqual([]);
  });

  it('the plan header documents the state markers and the sweep', () => {
    expect(plan).toContain('State markers (XC-11)');
    expect(plan).toContain('— ✅ done <date>');
    const contributing = readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain('## Plan maintenance (XC-11)');
    expect(contributing).toContain('Plan sweep — <date>');
  });
});
