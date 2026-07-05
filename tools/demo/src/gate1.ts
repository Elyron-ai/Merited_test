import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm gate:1` (PH1-28): the Phase-1 gate aggregator — every §9 Phase-1
 * criterion's AUTOMATED proxy in one run, exit 0 iff all pass. The living
 * checklist (including the manual items this script cannot prove) is
 * tools/demo/phase1-gate.md; a `--record` run appends its result table to
 * docs/gates/phase-1.md for the gate review. Commands run sequentially with
 * inherited stdio — the gate is a judgement artefact, not a speed benchmark.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type CriterionKind = 'automated' | 'manual';

export interface Gate1Criterion {
  /** §9 Phase-1 / gate-mapping row this proves (or defers to a human). */
  criterion: string;
  kind: CriterionKind;
  command?: string;
  note: string;
}

export const GATE1_CRITERIA: Gate1Criterion[] = [
  {
    criterion: 'Contract suite green against the REAL trio (unchanged suite, real crypto)',
    kind: 'automated',
    command: 'MERITED_TEST_CRYPTO=ed25519 pnpm trio:contract-test',
    note: 'the frozen 43-test suite, zero edits (XC-7), over real Ed25519/PASETO (PH1-24…26/30 — the simulators replaced file-for-file)',
  },
  {
    criterion: 'Contract suite still green against the simulators (regression)',
    kind: 'automated',
    command: 'pnpm trio:contract-test',
    note: 'same suite, fake crypto — both targets from one codebase (XC-12)',
  },
  {
    criterion: 'Mint-vs-claim monitor live',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/analytics/mint-vs-claim-monitor.integration.test.ts src/modules/analytics/analytics.integration.test.ts',
    note: 'PH1-19 projections (rebuild diff=∅, BUDGET_EXHAUSTED one-cycle) + PH1-20 synthetic under-report alert, floors/windows, badge read model; the live drill runs inside the full-dress suite below',
  },
  {
    criterion: 'MCP server passes inspector',
    kind: 'automated',
    command: 'pnpm --filter @merited/mcp-server exec vitest run test/inspector.integration.test.ts',
    note: 'PH1-6: scripted inspector over all three tools (search_offers, get_quote, check_eligibility)',
  },
  {
    criterion: 'Mandate + approval property tests green',
    kind: 'automated',
    command:
      'pnpm --filter @merited/wallet exec vitest run src/modules/mandates/attenuation.property.test.ts src/modules/mandates/mandates.integration.test.ts src/modules/notifications/approvals.e2e.test.ts',
    note: 'PH1-16 attenuation-never-escalation (fast-check) + revocation + pre_authorised_up_to; PH1-18 single-use, quote-bound, all four §6.4 verbatim accepts incl. APPROVAL_*/LIMIT_EXCEEDED against the simulator',
  },
  {
    criterion: 'OAuth linking round-trip in CI',
    kind: 'automated',
    command:
      'pnpm --filter @merited/wallet exec vitest run src/modules/linking/linking.integration.test.ts src/modules/linking/hosted/hosted-linking.integration.test.ts',
    note: 'PH1-10/12/13: wallet session → FakeAurora consent → callback → IdentityLink → revoke live; PH1-14 hosted fallback byte-compatible',
  },
  {
    criterion: 'Walletless-T1 via sub_hash proven',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/identity/walletless-t1.e2e.test.ts src/modules/identity/link-resolution.integration.test.ts',
    note: 'PH1-15: a non-wallet SDK agent presenting a link sub_hash receives a T1 member-priced quote; revocation downgrades the next quote (≤5s live)',
  },
  {
    criterion: 'Full-dress FakeAurora E2E on real rails — both flows + drills (SYN-33)',
    kind: 'automated',
    command: 'pnpm --filter @merited/demo exec vitest run src/e2e-phase1.test.ts',
    note: 'PH1-27: walletless + wallet-path flows on the real trio, one trace each, negatives on real rails, under-reporting drill alerts within one cycle, webhook replay → one claim',
  },
  {
    criterion: 'Workspace green: every Phase-1 module Accept clause in CI',
    kind: 'automated',
    command: 'pnpm -r build && pnpm -r test && pnpm lint',
    note: 'the complete suite — unit, integration, property, e2e — plus the XC-2/FND-15 lint rules',
  },
  {
    criterion: 'LEAD-5 external security audit commissioned',
    kind: 'manual',
    note: 'founder action: engagement booked, findings tracked to close before real-money exposure (v1.1 gate row)',
  },
  {
    criterion: 'Key-rotation runbook rehearsed operationally and minuted for LEAD-5',
    kind: 'manual',
    note: 'the MECHANICS are proven in CI (rotation-tolerance suite, real crypto); the timed operational drill per runbook §3 is run and minuted at the gate sitting',
  },
  {
    criterion: 'Phase-2 modules not started (§0.1)',
    kind: 'manual',
    note: 'reviewed against BUILD-PLAN task states at the gate sitting',
  },
];

export interface CriterionResult extends Gate1Criterion {
  outcome: 'pass' | 'fail' | 'manual';
}

export interface Gate1Run {
  results: CriterionResult[];
  exitCode: 0 | 1;
}

export type Exec = (command: string) => void; // throws on non-zero

export const runGate1 = (exec: Exec, log: (line: string) => void = console.log): Gate1Run => {
  const results: CriterionResult[] = [];
  for (const criterion of GATE1_CRITERIA) {
    if (criterion.kind === 'manual') {
      results.push({ ...criterion, outcome: 'manual' });
      log(`◻ MANUAL  ${criterion.criterion}`);
      continue;
    }
    log(`▶ ${criterion.criterion}`);
    log(`  $ ${criterion.command}`);
    try {
      exec(criterion.command!);
      results.push({ ...criterion, outcome: 'pass' });
      log(`✓ PASS    ${criterion.criterion}`);
    } catch {
      results.push({ ...criterion, outcome: 'fail' });
      log(`✗ FAIL    ${criterion.criterion}`);
    }
  }
  const failed = results.filter((r) => r.outcome === 'fail');
  log('');
  log(
    `Gate 1: ${results.filter((r) => r.outcome === 'pass').length} automated pass, ${failed.length} fail, ${results.filter((r) => r.outcome === 'manual').length} manual.`,
  );
  return { results, exitCode: failed.length === 0 ? 0 : 1 };
};

export const recordMarkdown = (run: Gate1Run, when: string): string => {
  const lines = [
    '',
    `## Gate 1 run — ${when}`,
    '',
    '| Outcome | Criterion | Proxy |',
    '|---|---|---|',
    ...run.results.map(
      (r) =>
        `| ${r.outcome === 'pass' ? '✅ pass' : r.outcome === 'fail' ? '❌ FAIL' : '◻ manual'} | ${r.criterion} | ${r.command ? `\`${r.command}\`` : r.note} |`,
    ),
    '',
    `Automated verdict: **${run.exitCode === 0 ? 'GREEN' : 'RED'}** (exit ${run.exitCode}). Manual items are decided at the gate sitting, not by this script.`,
    '',
  ];
  return lines.join('\n');
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const run = runGate1((command) =>
    execSync(command, { cwd: repoRoot, stdio: 'inherit', env: process.env }),
  );
  if (process.argv.includes('--record')) {
    const gatesDir = path.join(repoRoot, 'docs', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const file = path.join(gatesDir, 'phase-1.md');
    appendFileSync(file, recordMarkdown(run, new Date().toISOString()));
    console.log(`recorded → ${path.relative(repoRoot, file)}`);
  }
  process.exitCode = run.exitCode;
}
