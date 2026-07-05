# Phase 3 gate — Interop & exit-ready (PH3-10)

The three §9 Phase-3 clauses with their proxies, per the BUILD-PLAN §6 gate mapping.
Run via `pnpm gate:3` (add `--record` to append the result table below).

## Decision minute — 2026-07-05 (builder)

**Automated verdict: GREEN — 9 pass, 0 fail** (all three §9 clauses plus the interop,
Shopify-CI, SKU-granularity, spec-pinning and full-workspace rows). Manual rows for the
sitting: the verifier clean-container run is ALREADY EXECUTED and evidenced
(docs/gates/ph3-8-container-run.md, launch-readiness A13 ✅); the Shopify dev-store
end-to-end (A12) awaits LEAD-3/B7; the carried founder items (B1/A7 Stripe transfer,
A11 recording, LEAD-5, Q12/Q5) are unchanged from the Phase-2 sitting.

**Phase 3 is the FINAL build phase.** With this gate GREEN, all 10 PH3 rows are ✅ and
no build-phase tasks remain anywhere in BUILD-PLAN §5–§6. Everything outstanding is
founder/external and lives in docs/launch-readiness.md: credentials (B-section),
manual proofs (A-section), open questions (C3) and recorded gaps (GAP rows, incl.
GAP-9 proof-pack export tooling). Builder attestation: the frozen trio contract suite
ends the build exactly as it entered Phase 1 — untouched; no Accept clause was
weakened, skipped or deleted anywhere in Phases 0–3.

Founder acceptance of this gate (§0.1) closes the build. — Recorded by the builder;
the founder decides at the sitting.
## Gate 3 — Interop & exit-ready (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9.

- [x] A third party verifies a conversion from published head-hashes +
      a COR without Merited access (reference verifier) — PH3-8, incl. the
      clean-container run (docs/gates/ph3-8-container-run.md).
- [x] Anonymous JSON-LD reads are untokenised (visible, not payable) — PH3-1.
- [x] A new merchant self-onboards with no manual steps — PH3-6.

## Gate 3 run — 2026-07-05T21:57:35.013Z

| Outcome | Criterion | Proxy |
|---|---|---|
| ✅ pass | GATE CLAUSE 1 — third party verifies a conversion from published head-hashes + a COR without Merited access | `pnpm --filter @merited/verifier test` |
| ✅ pass | GATE CLAUSE 2 — anonymous JSON-LD reads are untokenised | `pnpm --filter @merited/core exec vitest run src/modules/offers/feed/feed.integration.test.ts` |
| ✅ pass | GATE CLAUSE 3 — a new merchant self-onboards without manual steps | `pnpm --filter @merited/control-plane exec vitest run test/signup.e2e.test.ts` |
| ✅ pass | Protocol interop — UCP + ACP real adapters through the shared conformance suite and intake posture | `pnpm --filter @merited/core exec vitest run src/modules/adapters/protocol/ src/modules/adapters/ucp/ src/modules/adapters/acp/` |
| ✅ pass | Valet completes errands over ALL THREE Phase-3 rails (UCP, ACP, Shopify) | `pnpm --filter @merited/valet exec vitest run test/ucp-rail.e2e.test.ts test/acp-rail.e2e.test.ts test/shopify-rail.e2e.test.ts` |
| ✅ pass | Shopify Grade A CI legs — CommerceAdapter parity + native-HMAC orders/paid intake | `pnpm --filter @merited/core exec vitest run src/modules/adapters/commerce/` |
| ✅ pass | SKU-level granularity end-to-end (eligibility, quoting, per-SKU JSON-LD, bundle resolution) | `pnpm --filter @merited/core exec vitest run src/modules/eligibility/sku-scope.test.ts src/modules/offers/sku-granularity.integration.test.ts` |
| ✅ pass | The open verification spec stays pinned to the primitives | `pnpm --filter @merited/events exec vitest run src/verification-spec.test.ts` |
| ✅ pass | Workspace green: every Phase-3 module Accept clause in CI | `pnpm -r build && pnpm -r test && pnpm lint` |
| ◻ manual | Verifier clean-container run (network egress disabled) — RECORDED | EXECUTED 2026-07-05, evidence with exact commands and outputs in docs/gates/ph3-8-container-run.md: --network=none --read-only, only the pack mounted → VERIFIED exit 0; one mutated byte → INVALID exit 1 (launch-readiness A13 ✅) |
| ◻ manual | Shopify dev-store end-to-end (install → cart attribute → orders/paid → verified) | founder action: LEAD-3/B7 Partner account + dev store (launch-readiness A12 carries the exact wiring); the code side shipped in PH3-5 and is proven against the wire-faithful simulated store |
| ◻ manual | Carried founder items: Stripe test-mode transfer (B1/A7), Act-2 recording (A11), LEAD-5 audit/hosting, Q12/Q5 | unchanged from the Phase-2 sitting — they gate real-money/launch exposure, not the build; the full register is docs/launch-readiness.md |
| ◻ manual | Founder gate acceptance at the sitting (§0.1) — Phase 3 is the FINAL build phase | after acceptance, no build phases remain: everything outstanding lives in docs/launch-readiness.md (founder/external items + recorded gaps) |

Automated verdict: **GREEN** (exit 0). Manual items are decided at the gate sitting, not by this script.
