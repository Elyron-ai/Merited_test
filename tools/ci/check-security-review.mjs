// XC-3 (SYN-32): CI enforcement of the mandatory security self-review on
// high-scrutiny-zone PRs. If the diff touches a zone (table XC.7), the PR
// body must carry the template's "Security self-review" section with EVERY
// box ticked — an unticked box or a deleted section fails the check with a
// message naming the zone files. Non-zone PRs pass untouched.
//
// Inputs: changed files from `git diff --name-only <base>...HEAD` (base ref
// in GITHUB_BASE_REF, as the ci.yml job wires it), PR body in PR_BODY.
import { execSync } from 'node:child_process';
import { touchesHighScrutinyZone } from './high-scrutiny-zones.mjs';

const SECTION = /##\s*Security self-review/i;

/** True when the body carries the section and no unticked boxes inside it. */
export const checklistSatisfied = (body) => {
  if (!body || !SECTION.test(body)) return false;
  const start = body.search(SECTION);
  const rest = body.slice(start);
  const nextHeading = rest.slice(2).search(/\n##\s/);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 2);
  const boxes = section.match(/- \[[ xX]\]/g) ?? [];
  if (boxes.length === 0) return false; // a heading with the checklist deleted
  return boxes.every((box) => /- \[[xX]\]/.test(box));
};

export const run = ({ changedFiles, body, log = console.log, fail = console.error }) => {
  const zoneFiles = touchesHighScrutinyZone(changedFiles);
  if (zoneFiles.length === 0) {
    log('security-review: no high-scrutiny zone touched — nothing to enforce.');
    return 0;
  }
  if (checklistSatisfied(body)) {
    log(`security-review: ${zoneFiles.length} zone file(s), checklist complete.`);
    return 0;
  }
  fail('✗ This PR touches high-scrutiny zone files (BUILD-PLAN §8, XC.7):');
  for (const file of zoneFiles.slice(0, 20)) fail(`    ${file}`);
  fail('  → Complete the "Security self-review" section of the PR description');
  fail('    (every box ticked). The section is in the PR template; zone PRs');
  fail('    are auto-labelled high-scrutiny and audited via the label query.');
  return 1;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  // CI: origin/<base branch> (fetch-depth 0). Local pre-push runs can point
  // SECURITY_REVIEW_BASE at any ref, e.g. HEAD~1.
  const base = process.env.SECURITY_REVIEW_BASE || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  const changedFiles = execSync(`git diff --name-only ${base}...HEAD`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  process.exitCode = run({ changedFiles, body: process.env.PR_BODY ?? '' });
}
