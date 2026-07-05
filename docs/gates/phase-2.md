# Gate 2 — Optimiser & scale (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9.

- [ ] `pnpm demo:act2` end-to-end on real rails: link Aurora Club →
      mandate → brief Valet → push notification → approve → transact →
      Aurora Club points credited on the activity screen.
- [ ] Netting run produces a real Stripe Connect transfer in test mode
      (no live-mode key accepted while LEAD-2 or LEAD-5 is unresolved).
- [ ] Decisioner swap (`RulesDecisioner` → `RandomDecisioner`) requires
      zero API changes — proved in CI (ranking-only diff).
- [ ] Act 2 negative cases scripted: mid-errand mandate revocation →
      `MANDATE_REVOKED`; declined notification → errand `DECLINED`,
      nothing charged or settled.

## Gate 2 run — 2026-07-05T18:45:28.179Z

| Outcome | Criterion | Proxy |
|---|---|---|
| ✅ pass | Wallet loop end-to-end on real rails (the gate sentence) + both §10 negatives + one trace + byte-identical transcript | `pnpm --filter @merited/demo exec vitest run test/act2.e2e.test.ts` |
| ✅ pass | Decisioner swap requires zero API changes (proved in CI) | `pnpm --filter @merited/core exec vitest run src/modules/decisioning/decisioner-swap.integration.test.ts src/modules/offers/read-offers.integration.test.ts` |
| ✅ pass | Stripe Connect payout rail — contract parity, env guard, worker (CI proxy over a faithful fake) | `pnpm --filter @merited/core exec vitest run src/modules/adapters/payouts/` |
| ✅ pass | Guardrails full — §5.6 accept verbatim | `pnpm --filter @merited/core exec vitest run src/modules/guardrails/guardrails.test.ts src/modules/guardrails/guardrails.integration.test.ts` |
| ✅ pass | Merchant dashboard renders from B19 projections alone; rebuild-identical | `pnpm --filter @merited/control-plane exec vitest run test/dashboard-sources.test.ts test/dashboard.e2e.test.ts` |
| ✅ pass | Act-2 steps performable through the six wallet screens | `pnpm --filter @merited/wallet-ui test` |
| ✅ pass | Valet full — live approval loop, kill/restart, §6.1/§6.4 negatives | `pnpm --filter @merited/valet test` |
| ✅ pass | Loyalty points credit idempotent per claim; walletless credits nothing | `pnpm --filter @merited/wallet exec vitest run src/modules/loyalty/points-credit.integration.test.ts` |
| ✅ pass | 1pd mandate-gated into DecisionCtx, never in responses (test + lint rule) | `pnpm --filter @merited/core exec vitest run src/modules/identity/pd-reader.integration.test.ts` |
| ✅ pass | ML training on ledger exhaust, reproducible from a rebuilt schema | `pnpm --filter @merited/ml-decisioner test` |
| ✅ pass | Workspace green: every Phase-2 module Accept clause in CI | `pnpm -r build && pnpm -r test && pnpm lint` |
| ◻ manual | REAL Stripe Connect test-mode transfer ID filed as evidence | founder action: LEAD-1 keys (launch-readiness B1) → run the netting flow with MERITED_STRIPE_SECRET_KEY=sk_test_… → file the tr_… id here (launch-readiness A7); the adapter needs zero code changes |
| ◻ manual | Act 2 recorded on camera with VALET_DETERMINISTIC=1 | recording session (launch-readiness A11): pnpm demo:act2 through the wallet UI screens; CI already proves the transcript is byte-identical run to run |
| ◻ manual | LEAD-5 audit + hosting decision (carried from the Phase-1 sitting) | Q12/Q5 remain the founder's: they gate REAL-MONEY exposure (live Stripe keys, real cutover), per the Phase-2 crossing minute — not the build |
| ◻ manual | Phase-3 modules not started (§0.1) | reviewed against BUILD-PLAN task states at the gate sitting |

Automated verdict: **GREEN** (exit 0). Manual items are decided at the gate sitting, not by this script.

## Gate decision minute — 2026-07-05

**Automated verdict: GREEN** — all 11 automated §9 Phase-2 clauses pass in one sequential run on this machine (first run, no re-runs needed): the wallet loop end-to-end on real rails with both §10 negatives and the brief→ledger trace; decisioner swap proved schema-identical against the LIVE Python sidecar; Stripe rail contract parity + env guard + worker convergence (CI proxy); guardrails §5.6 verbatim; the B19 dashboard rebuild-identical; all six wallet screens; Valet's live approval loop with kill/restart; idempotent points credit; mandate-gated 1pd; reproducible ledger-exhaust training; and the full workspace suite. The frozen trio contract suite was untouched throughout Phase 2 (XC-7: zero edits).

**Manual items filed to the founder (the gate sitting decides):**
1. **REAL Stripe Connect test-mode transfer** — needs LEAD-1 keys (launch-readiness B1, START NOW); one env variable, zero code changes, file the `tr_…` id here (A7).
2. **Act-2 recording** with `VALET_DETERMINISTIC=1` (A11) — CI already proves transcript byte-identity.
3. **Q12 (LEAD-5 audit sign-off) + Q5 (hosting)** — carried from the Phase-1 sitting; they gate REAL-MONEY exposure per the Phase-2 crossing minute, and the live-key guard in code (`LIVE_RAILS_APPROVED = false`) enforces exactly that.
4. **Phase-order attestation:** the builder attests no Phase-3 module has been started (§0.1). Phase-3 work begins only after this gate is accepted at the sitting.

**Builder attestation:** all 12 PH2 task rows ✅ (PH2-1…PH2-12) plus TRIO-17, XC-13 (pack assembled, ⛔ on founder items) and LEAD-4 closed en route. `docs/launch-readiness.md` carries the full open register: A-items (tests needing real services), B-items (credentials — B1 Stripe remains the founder's clock), C2 (all of Phase 3), C3 (founder questions).
