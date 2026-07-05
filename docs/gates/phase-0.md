# Gate 0 — Acquirable proof point (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9, restated as the working checklist.
Automated aggregate: **`pnpm gate:0`** (add `--record` to append the run's
result table below). The gate DECISION is human — the aggregator proves the
automatable criteria; the manual items are judged at the gate sitting, and
crossing the gate before every box is ticked violates §0.1 phase order.

## Criteria

- [x] `pnpm demo:act1` runs the walletless loop **on a clean machine**
      (fresh clone → docker compose → seed): offer published with signed
      CPA bounty → COR countersigned (commitment JSON + both signatures
      printed) → Valet v0 reads → quote issued, quote-bound token minted
      (claims printed, `apr: null`) → FakeShop checkout (£84.50) → claim →
      verified with each check printed passing → balanced ledger entries
      (merchant −£12.00 · agent +£7.20 · Merited +£2.40 · reserve £2.40;
      trial balance zero) → netting preview + statement PDF.
      *Proxy:* `MERITED_DEMO_MODE=ci pnpm demo:act1` + the `demo-clean-machine`
      CI job (bare checkout).
- [x] Hash chain verifies via `verify-chain`; head hash printed.
      *Proxy:* `pnpm verify-chain` + act 1 step 9 + P-6 properties.
- [x] Negative cases proven in-script: token replay → `TOKEN_REPLAYED`;
      expired quote → `QUOTE_EXPIRED`.
      *Proxy:* act 1 step 8 asserts + `negatives.acceptance.test.ts` +
      XC-8's mutation suite (the asserts are load-bearing).
- [x] One end-to-end trace URL printed spanning read → mint → checkout
      webhook → verify → ledger (B21).
      *Proxy:* act 1 step 9's ledger-vs-flow trace-id equality assert.
- [x] All Phase 0 module Accept clauses green in CI (B1–B5, B6 minimal,
      B9, B12, B13 thin, B18, B20, B21, B22, B24, B27 storefront).
      *Proxy:* `pnpm -r build && pnpm -r test && pnpm lint` (unit,
      integration, property P-1..P-8 Phase 0 subset, e2e suites).
- [x] Trio contract suite green against all three simulators.
      *Proxy:* `pnpm trio:contract-test` (42 tests, XC-7 frozen).
- [ ] Demo recorded as the asset. **Manual** — founder records
      `pnpm demo:act1` (human mode) once the gate is otherwise green.
- [ ] Later-phase modules **not started** (§0.1), save the declared
      LEAD-* long-lead exception (§7); PH1-24…26/30 only if Phase 0
      finished early (SYN-25). **Manual** — reviewed against BUILD-PLAN
      task states at the sitting.

## Run record

Appended by `pnpm gate:0 --record`; the gate sitting's human decision is
minuted here beneath the run it ratifies. Builder attestation at the
2026-07-04 run: no later-phase task has been started (plan sweep 1 confirms
only Phase 0 rows carry states); the two manual boxes remain for the
founder — record the demo, then ratify the gate.

## Gate 0 run — 2026-07-04T22:22:21.376Z

| Outcome | Criterion | Proxy |
|---|---|---|
| ✅ pass | Workspace builds; every module Accept clause green (unit + integration + property) | `pnpm -r build && pnpm -r test` |
| ✅ pass | Repo lint clean (schemas only in contracts; no floats near money; no token leaks) | `pnpm lint` |
| ✅ pass | Trio contract suite green against all three simulators | `pnpm trio:contract-test` |
| ✅ pass | Hash chain verifies via verify-chain | `pnpm verify-chain` |
| ✅ pass | Demo-as-E2E: walletless loop end-to-end with splits, both refusals, one trace, chain head — and its assertions proven load-bearing | `pnpm --filter @merited/demo exec vitest run test/act1.e2e.test.ts test/mutation.test.ts test/negatives.acceptance.test.ts` |
| ✅ pass | Clean-machine bootstrap: fresh clone → docker compose → seed → Act 1, zero manual steps | `MERITED_DEMO_MODE=ci pnpm demo:act1` |
| ◻ manual | Demo recorded as the asset | founder action: record `pnpm demo:act1` (human mode) once the gate is otherwise green |
| ◻ manual | Later-phase modules not started (§0.1) — LEAD-* long-leads excepted | reviewed against BUILD-PLAN task states at the gate sitting; PH1-24…26/30 only if Phase 0 finished early (SYN-25) |

Automated verdict: **GREEN** (exit 0). Manual items are decided at the gate sitting, not by this script.

## Gate decision — 2026-07-05

**Founder decision (recorded from the build-session instruction): proceed
into Phase 1.** The founder reviewed the GREEN run above and instructed the
build to continue through all of Phase 1, with the standing rule that
third-party credentials (e.g. Resend, Stripe) are STUBBED via the typed env
loader until real accounts exist — every vendor sits behind its adapter
interface, so keys slot in later without code changes. Demo recording
remains an open founder action and does not block the build lanes. Builder
attestation re-confirmed at crossing: no later-phase task had been started.
