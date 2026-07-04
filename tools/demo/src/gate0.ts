import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm gate:0` (XC-9): the Phase 0 gate aggregator — every §9 criterion's
 * AUTOMATED proxy in one run, exit 0 iff all pass. The living checklist
 * (including the manual items this script cannot prove) is
 * docs/gates/phase-0.md; a `--record` run appends its result table there
 * for the gate review. Commands run sequentially with inherited stdio —
 * the gate is a judgement artefact, not a speed benchmark.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type CriterionKind = 'automated' | 'manual';

export interface Gate0Criterion {
  /** §9 / XC.5 checklist line this proves (or defers to a human). */
  criterion: string;
  kind: CriterionKind;
  /** The automated proxy; absent for manual items. */
  command?: string;
  /** Why this command is an honest proxy / what the human must do. */
  note: string;
}

export const GATE0_CRITERIA: Gate0Criterion[] = [
  {
    criterion: 'Workspace builds; every module Accept clause green (unit + integration + property)',
    kind: 'automated',
    command: 'pnpm -r build && pnpm -r test',
    note: 'B1–B5, B6 minimal, B9, B12, B13 thin, B18, B20–B22, B24, B27 Accepts live in these suites (529 tests incl. P-1..P-8 Phase 0 subset)',
  },
  {
    criterion: 'Repo lint clean (schemas only in contracts; no floats near money; no token leaks)',
    kind: 'automated',
    command: 'pnpm lint',
    note: 'XC-2 rules + FND-15 sweep at error level',
  },
  {
    criterion: 'Trio contract suite green against all three simulators',
    kind: 'automated',
    command: 'pnpm trio:contract-test',
    note: '42 tests, frozen under XC-7 zero-edit change control',
  },
  {
    criterion: 'Hash chain verifies via verify-chain',
    kind: 'automated',
    command: 'pnpm verify-chain',
    note: 'runs against the compose database written by the demo; P-6 properties cover generated sequences',
  },
  {
    criterion:
      'Demo-as-E2E: walletless loop end-to-end with splits, both refusals, one trace, chain head — and its assertions proven load-bearing',
    kind: 'automated',
    command:
      'pnpm --filter @merited/demo exec vitest run test/act1.e2e.test.ts test/mutation.test.ts test/negatives.acceptance.test.ts',
    note: 'the same suites the demo-e2e CI job runs (VAL-14 + XC-8)',
  },
  {
    criterion: 'Clean-machine bootstrap: fresh clone → docker compose → seed → Act 1, zero manual steps',
    kind: 'automated',
    command: 'MERITED_DEMO_MODE=ci pnpm demo:act1',
    note: 'bootstrap preflight + compose + migrate + the full act (VAL-15); CI proves the bare-checkout variant in demo-clean-machine',
  },
  {
    criterion: 'Demo recorded as the asset',
    kind: 'manual',
    note: 'founder action: record `pnpm demo:act1` (human mode) once the gate is otherwise green',
  },
  {
    criterion: 'Later-phase modules not started (§0.1) — LEAD-* long-leads excepted',
    kind: 'manual',
    note: 'reviewed against BUILD-PLAN task states at the gate sitting; PH1-24…26/30 only if Phase 0 finished early (SYN-25)',
  },
];

export interface CriterionResult extends Gate0Criterion {
  outcome: 'pass' | 'fail' | 'manual';
}

export interface Gate0Run {
  results: CriterionResult[];
  exitCode: 0 | 1;
}

export type Exec = (command: string) => void; // throws on non-zero

export const runGate0 = (exec: Exec, log: (line: string) => void = console.log): Gate0Run => {
  const results: CriterionResult[] = [];
  for (const criterion of GATE0_CRITERIA) {
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
  log(`Gate 0: ${results.filter((r) => r.outcome === 'pass').length} automated pass, ${failed.length} fail, ${results.filter((r) => r.outcome === 'manual').length} manual.`);
  return { results, exitCode: failed.length === 0 ? 0 : 1 };
};

export const recordMarkdown = (run: Gate0Run, when: string): string => {
  const lines = [
    '',
    `## Gate 0 run — ${when}`,
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
  const run = runGate0((command) =>
    execSync(command, { cwd: repoRoot, stdio: 'inherit', env: process.env }),
  );
  if (process.argv.includes('--record')) {
    const gatesDir = path.join(repoRoot, 'docs', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const file = path.join(gatesDir, 'phase-0.md');
    appendFileSync(file, recordMarkdown(run, new Date().toISOString()));
    console.log(`recorded → ${path.relative(repoRoot, file)}`);
  }
  process.exitCode = run.exitCode;
}
