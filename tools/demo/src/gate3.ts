import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm gate:3` (PH3-10): the Phase-3 gate aggregator — all three §9
 * Phase-3 clauses' automated proxies plus the interop/scale supporting
 * suites, exit 0 iff all pass, mirroring the PH1-28/PH2-12 pattern.
 * `--record` appends the result table to docs/gates/phase-3.md. Manual
 * rows name what only the founder (or external services) can finish —
 * Phase 3 is the FINAL build phase, so those rows plus the launch-readiness
 * register are everything that remains after this gate.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type CriterionKind = 'automated' | 'manual';

export interface Gate3Criterion {
  criterion: string;
  kind: CriterionKind;
  command?: string;
  note: string;
}

export const GATE3_CRITERIA: Gate3Criterion[] = [
  {
    criterion:
      'GATE CLAUSE 1 — third party verifies a conversion from published head-hashes + a COR without Merited access',
    kind: 'automated',
    command: 'pnpm --filter @merited/verifier test',
    note: 'PH3-8 (built strictly against PH3-7): a REAL conversion (Ed25519 CORs, PASETO token, trio verdict, published head) verifies OFFLINE; tamper matrix covers every event row byte, forged claims, swapped keys, missing anchors, dev fake formats; REJECTED reason round-trips; the CLI exits 0',
  },
  {
    criterion: 'GATE CLAUSE 2 — anonymous JSON-LD reads are untokenised',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/offers/feed/feed.integration.test.ts',
    note: 'PH3-1: anonymous fetch carries zero token material and mints NOTHING (ledger assertion); the SAME feed registered mints and carries merited:* fields; schema.org-valid',
  },
  {
    criterion: 'GATE CLAUSE 3 — a new merchant self-onboards without manual steps',
    kind: 'automated',
    command: 'pnpm --filter @merited/control-plane exec vitest run test/signup.e2e.test.ts',
    note: 'PH3-6: fresh public signup (no session cookie anywhere) → merchant + trio keypair + integration credential + first offer LIVE → a registered agent receives it as a tokenised quote; dashboard stays locked; bad input never half-onboards',
  },
  {
    criterion: 'Protocol interop — UCP + ACP real adapters through the shared conformance suite and intake posture',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/adapters/protocol/ src/modules/adapters/ucp/ src/modules/adapters/acp/',
    note: 'PH3-2/3/4: token rides EXACTLY the designated field both ways; signed callbacks → trio-verified claims with ORIGINAL qid/jti; tokenless → no claim (P2); one audited intake posture for every protocol',
  },
  {
    criterion: 'Valet completes errands over ALL THREE Phase-3 rails (UCP, ACP, Shopify)',
    kind: 'automated',
    command:
      'pnpm --filter @merited/valet exec vitest run test/ucp-rail.e2e.test.ts test/acp-rail.e2e.test.ts test/shopify-rail.e2e.test.ts',
    note: '§6.6 Phase-3 rails: BRIEFED→…→CONFIRMED on each, verified claim qid = the errand’s own quote id',
  },
  {
    criterion: 'Shopify Grade A CI legs — CommerceAdapter parity + native-HMAC orders/paid intake',
    kind: 'automated',
    command: 'pnpm --filter @merited/core exec vitest run src/modules/adapters/commerce/',
    note: 'PH3-5: the contract suite passes FakeShop AND Shopify; cart-attribute token → orders/paid → verified with original qid/jti; £-decimal strings cross by string maths; §8 verification on even in dev',
  },
  {
    criterion: 'SKU-level granularity end-to-end (eligibility, quoting, per-SKU JSON-LD, bundle resolution)',
    kind: 'automated',
    command:
      'pnpm --filter @merited/core exec vitest run src/modules/eligibility/sku-scope.test.ts src/modules/offers/sku-granularity.integration.test.ts',
    note: 'PH3-9: scoped offers quote only for matching SKU queries (determinism per §5.4); sku_scope \'all\' unchanged; bundle sku_refs resolve against FakeShop’s seeded catalogue',
  },
  {
    criterion: 'The open verification spec stays pinned to the primitives',
    kind: 'automated',
    command: 'pnpm --filter @merited/events exec vitest run src/verification-spec.test.ts',
    note: 'PH3-7: the doc’s worked example recomputes EXACTLY via canonicalJson/chainHash; every normative string asserted',
  },
  {
    criterion: 'Workspace green: every Phase-3 module Accept clause in CI',
    kind: 'automated',
    command: 'pnpm -r build && pnpm -r test && pnpm lint',
    note: 'the complete suite + all lint fences; the frozen trio contract suite untouched through Phase 3',
  },
  {
    criterion: 'Verifier clean-container run (network egress disabled) — RECORDED',
    kind: 'manual',
    note: 'EXECUTED 2026-07-05, evidence with exact commands and outputs in docs/gates/ph3-8-container-run.md: --network=none --read-only, only the pack mounted → VERIFIED exit 0; one mutated byte → INVALID exit 1 (launch-readiness A13 ✅)',
  },
  {
    criterion: 'Shopify dev-store end-to-end (install → cart attribute → orders/paid → verified)',
    kind: 'manual',
    note: 'founder action: LEAD-3/B7 Partner account + dev store (launch-readiness A12 carries the exact wiring); the code side shipped in PH3-5 and is proven against the wire-faithful simulated store',
  },
  {
    criterion: 'Carried founder items: Stripe test-mode transfer (B1/A7), Act-2 recording (A11), LEAD-5 audit/hosting, Q12/Q5',
    kind: 'manual',
    note: 'unchanged from the Phase-2 sitting — they gate real-money/launch exposure, not the build; the full register is docs/launch-readiness.md',
  },
  {
    criterion: 'Founder gate acceptance at the sitting (§0.1) — Phase 3 is the FINAL build phase',
    kind: 'manual',
    note: 'after acceptance, no build phases remain: everything outstanding lives in docs/launch-readiness.md (founder/external items + recorded gaps)',
  },
];

export interface CriterionResult extends Gate3Criterion {
  outcome: 'pass' | 'fail' | 'manual';
}

export interface Gate3Run {
  results: CriterionResult[];
  exitCode: 0 | 1;
}

export type Exec = (command: string) => void; // throws on non-zero

export const runGate3 = (exec: Exec, log: (line: string) => void = console.log): Gate3Run => {
  const results: CriterionResult[] = [];
  for (const criterion of GATE3_CRITERIA) {
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
    `Gate 3: ${results.filter((r) => r.outcome === 'pass').length} automated pass, ${failed.length} fail, ${results.filter((r) => r.outcome === 'manual').length} manual.`,
  );
  return { results, exitCode: failed.length === 0 ? 0 : 1 };
};

export const recordMarkdown = (run: Gate3Run, when: string): string => {
  const lines = [
    '',
    `## Gate 3 run — ${when}`,
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
  const run = runGate3((command) =>
    execSync(command, { cwd: repoRoot, stdio: 'inherit', env: process.env }),
  );
  if (process.argv.includes('--record')) {
    const gatesDir = path.join(repoRoot, 'docs', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const file = path.join(gatesDir, 'phase-3.md');
    appendFileSync(file, recordMarkdown(run, new Date().toISOString()));
    console.log(`recorded → ${path.relative(repoRoot, file)}`);
  }
  process.exitCode = run.exitCode;
}
