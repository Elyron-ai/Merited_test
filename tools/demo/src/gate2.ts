import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm gate:2` (PH2-12): the Phase-2 gate aggregator — every §9 Phase-2
 * clause's AUTOMATED proxy in one run, exit 0 iff all pass, mirroring the
 * PH1-28 pattern. `--record` appends the result table to
 * docs/gates/phase-2.md for the gate sitting. Manual rows name what only a
 * human (or LEAD-1's Stripe keys) can finish.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type CriterionKind = 'automated' | 'manual';

export interface Gate2Criterion {
  criterion: string;
  kind: CriterionKind;
  command?: string;
  note: string;
}

export const GATE2_CRITERIA: Gate2Criterion[] = [
  {
    criterion: 'Wallet loop end-to-end on real rails (the gate sentence) + both §10 negatives + one trace + byte-identical transcript',
    kind: 'automated',
    command: 'pnpm --filter @merited/demo exec vitest run test/act2.e2e.test.ts',
    note: 'PH2-11: link → brief → notification → approve → transact → points credited; MANDATE_REVOKED + DECLINED fire, nothing charged; ConversionVerified carries the flow trace id; VALET_DETERMINISTIC=1 transcripts byte-identical (PH2-5)',
  },
  {
    criterion: 'Decisioner swap requires zero API changes (proved in CI)',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/decisioning/decisioner-swap.integration.test.ts src/modules/offers/read-offers.integration.test.ts',
    note: 'PH2-7: rules vs random vs the LIVE Python sidecar — identical offer sets, EMPTY per-offer schema diff; dead sidecar → rules-identical ranking; plus PH1-4\'s original swap test re-run verbatim',
  },
  {
    criterion: 'Stripe Connect payout rail — contract parity, env guard, worker (CI proxy over a faithful fake)',
    kind: 'automated',
    command: 'pnpm --filter @merited/core exec vitest run src/modules/adapters/payouts/',
    note: 'PH2-6: the SAME adapter contract suite passes SimulatedPayouts AND StripeConnectPayouts; live keys refused while LEAD-2/LEAD-5 open; one transfer per net position, replay/rebuild converge — the REAL test-mode transfer is the manual row below',
  },
  {
    criterion: 'Guardrails full — §5.6 accept verbatim',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/guardrails/guardrails.test.ts src/modules/guardrails/guardrails.integration.test.ts',
    note: 'PH2-1: budget exhaustion flips reads to no_offer with BUDGET_EXHAUSTED in analytics within one cycle; margin breach surfaced; λ re-rank deterministic',
  },
  {
    criterion: 'Merchant dashboard renders from B19 projections alone; rebuild-identical',
    kind: 'automated',
    command:
      'pnpm --filter @merited/control-plane exec vitest run test/dashboard-sources.test.ts test/dashboard.e2e.test.ts',
    note: 'PH2-2: structural source-scan + byte-identical pages after wipe+rebuild; BUDGET_EXHAUSTED visible (closes the §5.6 loop)',
  },
  {
    criterion: 'Act-2 steps performable through the six wallet screens',
    kind: 'automated',
    command: 'pnpm --filter @merited/wallet-ui test',
    note: 'PH2-3: screens 1–6 over the public wallet API alone; the consumer approves ON SCREEN; B23 revoke and §6.1 mandate paths have UI faces',
  },
  {
    criterion: 'Valet full — live approval loop, kill/restart, §6.1/§6.4 negatives',
    kind: 'automated',
    command: 'pnpm --filter @merited/valet test',
    note: 'PH2-4 (+ the frozen Phase-0 reducer suites): AWAITING_APPROVAL live, re-minted apr token to checkout, APPROVAL_MISSING / LIMIT_EXCEEDED / MANDATE_REVOKED on real rails; PH2-5 interpreter deterministic + fail-closed',
  },
  {
    criterion: 'Loyalty points credit idempotent per claim; walletless credits nothing',
    kind: 'automated',
    command:
      'pnpm --filter @merited/wallet exec vitest run src/modules/loyalty/points-credit.integration.test.ts',
    note: 'PH2-10: the production consumer of wallet-path ConversionVerified; replay + rebuild converge on ONE credit; revoked link = revoked consent',
  },
  {
    criterion: '1pd mandate-gated into DecisionCtx, never in responses (test + lint rule)',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/identity/pd-reader.integration.test.ts',
    note: 'PH2-9: fields present iff data_sharing allows; revocation strips on the next read; the no-1pd-leak rule runs repo-wide in the workspace lint below',
  },
  {
    criterion: 'ML training on ledger exhaust, reproducible from a rebuilt schema',
    kind: 'automated',
    command: 'pnpm --filter @merited/ml-decisioner test',
    note: 'PH2-8 (+LEAD-4): read-model-only source scan; thin→adequate via the deterministic generator; rebuild → train converges on the identical artefact version',
  },
  {
    criterion: 'Workspace green: every Phase-2 module Accept clause in CI',
    kind: 'automated',
    command: 'pnpm -r build && pnpm -r test && pnpm lint',
    note: 'the complete suite, plus the XC-2/FND-15/PH2-9 lint rules; the frozen trio contract suite untouched throughout Phase 2',
  },
  {
    criterion: 'REAL Stripe Connect test-mode transfer ID filed as evidence',
    kind: 'manual',
    note: 'founder action: LEAD-1 keys (launch-readiness B1) → run the netting flow with MERITED_STRIPE_SECRET_KEY=sk_test_… → file the tr_… id here (launch-readiness A7); the adapter needs zero code changes',
  },
  {
    criterion: 'Act 2 recorded on camera with VALET_DETERMINISTIC=1',
    kind: 'manual',
    note: 'recording session (launch-readiness A11): pnpm demo:act2 through the wallet UI screens; CI already proves the transcript is byte-identical run to run',
  },
  {
    criterion: 'LEAD-5 audit + hosting decision (carried from the Phase-1 sitting)',
    kind: 'manual',
    note: 'Q12/Q5 remain the founder\'s: they gate REAL-MONEY exposure (live Stripe keys, real cutover), per the Phase-2 crossing minute — not the build',
  },
  {
    criterion: 'Phase-3 modules not started (§0.1)',
    kind: 'manual',
    note: 'reviewed against BUILD-PLAN task states at the gate sitting',
  },
];

export interface CriterionResult extends Gate2Criterion {
  outcome: 'pass' | 'fail' | 'manual';
}

export interface Gate2Run {
  results: CriterionResult[];
  exitCode: 0 | 1;
}

export type Exec = (command: string) => void; // throws on non-zero

export const runGate2 = (exec: Exec, log: (line: string) => void = console.log): Gate2Run => {
  const results: CriterionResult[] = [];
  for (const criterion of GATE2_CRITERIA) {
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
    `Gate 2: ${results.filter((r) => r.outcome === 'pass').length} automated pass, ${failed.length} fail, ${results.filter((r) => r.outcome === 'manual').length} manual.`,
  );
  return { results, exitCode: failed.length === 0 ? 0 : 1 };
};

export const recordMarkdown = (run: Gate2Run, when: string): string => {
  const lines = [
    '',
    `## Gate 2 run — ${when}`,
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
  const run = runGate2((command) =>
    execSync(command, { cwd: repoRoot, stdio: 'inherit', env: process.env }),
  );
  if (process.argv.includes('--record')) {
    const gatesDir = path.join(repoRoot, 'docs', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const file = path.join(gatesDir, 'phase-2.md');
    appendFileSync(file, recordMarkdown(run, new Date().toISOString()));
    console.log(`recorded → ${path.relative(repoRoot, file)}`);
  }
  process.exitCode = run.exitCode;
}
