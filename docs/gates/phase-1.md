# Gate 1 — Harden & first partners (living record)

The working checklist (criteria + proxies + manual items) is
`tools/demo/phase1-gate.md`; the aggregator is **`pnpm gate:1`** (`--record`
appends its result table here). Per §0 rule 1, Phase-2 work may not start
while any row fails; the manual rows are decided by the founder at the gate
sitting.

## Gate 1 run — 2026-07-05T12:25:35.604Z

| Outcome | Criterion | Proxy |
|---|---|---|
| ✅ pass | Contract suite green against the REAL trio (unchanged suite, real crypto) | `MERITED_TEST_CRYPTO=ed25519 pnpm trio:contract-test` |
| ✅ pass | Contract suite still green against the simulators (regression) | `pnpm trio:contract-test` |
| ✅ pass | Mint-vs-claim monitor live | `pnpm --filter @merited/core exec vitest run src/modules/analytics/mint-vs-claim-monitor.integration.test.ts src/modules/analytics/analytics.integration.test.ts` |
| ✅ pass | MCP server passes inspector | `pnpm --filter @merited/mcp-server exec vitest run test/inspector.integration.test.ts` |
| ✅ pass | Mandate + approval property tests green | `pnpm --filter @merited/wallet exec vitest run src/modules/mandates/attenuation.property.test.ts src/modules/mandates/mandates.integration.test.ts src/modules/notifications/approvals.e2e.test.ts` |
| ✅ pass | OAuth linking round-trip in CI | `pnpm --filter @merited/wallet exec vitest run src/modules/linking/linking.integration.test.ts src/modules/linking/hosted/hosted-linking.integration.test.ts` |
| ✅ pass | Walletless-T1 via sub_hash proven | `pnpm --filter @merited/core exec vitest run src/modules/identity/walletless-t1.e2e.test.ts src/modules/identity/link-resolution.integration.test.ts` |
| ✅ pass | Full-dress FakeAurora E2E on real rails — both flows + drills (SYN-33) | `pnpm --filter @merited/demo exec vitest run src/e2e-phase1.test.ts` |
| ❌ FAIL | Workspace green: every Phase-1 module Accept clause in CI | `pnpm -r build && pnpm -r test && pnpm lint` |
| ◻ manual | LEAD-5 external security audit commissioned | founder action: engagement booked, findings tracked to close before real-money exposure (v1.1 gate row) |
| ◻ manual | Key-rotation runbook rehearsed operationally and minuted for LEAD-5 | the MECHANICS are proven in CI (rotation-tolerance suite, real crypto); the timed operational drill per runbook §3 is run and minuted at the gate sitting |
| ◻ manual | Phase-2 modules not started (§0.1) | reviewed against BUILD-PLAN task states at the gate sitting |

Automated verdict: **RED** (exit 1). Manual items are decided at the gate sitting, not by this script.

**Note on the 12:25 run:** the single ❌ was two control-plane e2e suites
failing in SETUP under the gate's full parallel load (Next server boot +
time-windowed TOTP login) — both passed 32/32 when re-run in isolation
immediately afterwards, and the same suites were green in the standalone
workspace run earlier the same hour. Recorded as an environment-contention
flake, not a criterion failure; the clean re-run follows below.

## Gate 1 run — 2026-07-05T12:29:34.774Z

| Outcome | Criterion | Proxy |
|---|---|---|
| ✅ pass | Contract suite green against the REAL trio (unchanged suite, real crypto) | `MERITED_TEST_CRYPTO=ed25519 pnpm trio:contract-test` |
| ✅ pass | Contract suite still green against the simulators (regression) | `pnpm trio:contract-test` |
| ✅ pass | Mint-vs-claim monitor live | `pnpm --filter @merited/core exec vitest run src/modules/analytics/mint-vs-claim-monitor.integration.test.ts src/modules/analytics/analytics.integration.test.ts` |
| ✅ pass | MCP server passes inspector | `pnpm --filter @merited/mcp-server exec vitest run test/inspector.integration.test.ts` |
| ✅ pass | Mandate + approval property tests green | `pnpm --filter @merited/wallet exec vitest run src/modules/mandates/attenuation.property.test.ts src/modules/mandates/mandates.integration.test.ts src/modules/notifications/approvals.e2e.test.ts` |
| ✅ pass | OAuth linking round-trip in CI | `pnpm --filter @merited/wallet exec vitest run src/modules/linking/linking.integration.test.ts src/modules/linking/hosted/hosted-linking.integration.test.ts` |
| ✅ pass | Walletless-T1 via sub_hash proven | `pnpm --filter @merited/core exec vitest run src/modules/identity/walletless-t1.e2e.test.ts src/modules/identity/link-resolution.integration.test.ts` |
| ✅ pass | Full-dress FakeAurora E2E on real rails — both flows + drills (SYN-33) | `pnpm --filter @merited/demo exec vitest run src/e2e-phase1.test.ts` |
| ✅ pass | Workspace green: every Phase-1 module Accept clause in CI | `pnpm -r build && pnpm -r test && pnpm lint` |
| ◻ manual | LEAD-5 external security audit commissioned | founder action: engagement booked, findings tracked to close before real-money exposure (v1.1 gate row) |
| ◻ manual | Key-rotation runbook rehearsed operationally and minuted for LEAD-5 | the MECHANICS are proven in CI (rotation-tolerance suite, real crypto); the timed operational drill per runbook §3 is run and minuted at the gate sitting |
| ◻ manual | Phase-2 modules not started (§0.1) | reviewed against BUILD-PLAN task states at the gate sitting |

Automated verdict: **GREEN** (exit 0). Manual items are decided at the gate sitting, not by this script.

## Gate decision — 2026-07-05

**Automated criteria: GREEN (9/9), zero test edits to the frozen contract
suite.** The 12:25 run's single failure was confirmed an environment-
contention flake (noted above) and the clean 12:4x re-run passed every
criterion including the full workspace suite. Evidence: the two recorded
tables above; the full-dress flows print their evidence JSON via
`pnpm --filter @merited/demo e2e:phase1` (walletless-T1 and approval flows —
the demo-adjacent assets); the run logs live with the CI job.

**Manual rows — assigned to the founder as BUILD-PLAN §9 Q12:** (1) LEAD-5
external security audit commissioned; (2) the timed key-rotation operational
drill per runbook §3, minuted. Builder attestation at this sitting: no
Phase-2 module has been started (§0.1) — reviewable against BUILD-PLAN task
states, where every PH2+ row is unmarked.

**Per §0 rule 1, Phase-2 work does not start until the founder resolves Q12
and minutes the crossing here.** Phase 1's build scope is complete: all 30
PH1 tasks ✅ (PH1-1…30), the trio real implementations landed behind the
unchanged suite (SYN-32), and the full-dress FakeAurora organisation stands
as the design-partner rehearsal (SYN-33).

## Phase-2 crossing — 2026-07-05

**Founder decision (recorded from the build-session instruction): proceed
into Phase 2.** The founder reviewed the GREEN automated verdict above and
instructed the build to start Phase 2 under the /build-next loop. The Q12
manual items remain OPEN founder actions — per LEAD-5's own row they gate
"real-money Phase 2 work, not the build", and PH2-6 carries an env-loader
guard refusing live-mode keys until LEAD-2 and LEAD-5 are resolved. All
gaps, credentials and untested items are retained in
`docs/launch-readiness.md` (created at this crossing, referenced from
CLAUDE.md). One Phase-1 leftover was surfaced by the crossing sweep —
**TRIO-17 (live directory wiring)**, an unmarked S-task in the trio
workstream — and is queued FIRST, before any Phase-2 module (§0.1).
