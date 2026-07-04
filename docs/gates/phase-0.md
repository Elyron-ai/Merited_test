# Gate 0 — Acquirable proof point (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9, restated as the working checklist.
Automated aggregate: **`pnpm gate:0`** (add `--record` to append the run's
result table below). The gate DECISION is human — the aggregator proves the
automatable criteria; the manual items are judged at the gate sitting, and
crossing the gate before every box is ticked violates §0.1 phase order.

## Criteria

- [ ] `pnpm demo:act1` runs the walletless loop **on a clean machine**
      (fresh clone → docker compose → seed): offer published with signed
      CPA bounty → COR countersigned (commitment JSON + both signatures
      printed) → Valet v0 reads → quote issued, quote-bound token minted
      (claims printed, `apr: null`) → FakeShop checkout (£84.50) → claim →
      verified with each check printed passing → balanced ledger entries
      (merchant −£12.00 · agent +£7.20 · Merited +£2.40 · reserve £2.40;
      trial balance zero) → netting preview + statement PDF.
      *Proxy:* `MERITED_DEMO_MODE=ci pnpm demo:act1` + the `demo-clean-machine`
      CI job (bare checkout).
- [ ] Hash chain verifies via `verify-chain`; head hash printed.
      *Proxy:* `pnpm verify-chain` + act 1 step 9 + P-6 properties.
- [ ] Negative cases proven in-script: token replay → `TOKEN_REPLAYED`;
      expired quote → `QUOTE_EXPIRED`.
      *Proxy:* act 1 step 8 asserts + `negatives.acceptance.test.ts` +
      XC-8's mutation suite (the asserts are load-bearing).
- [ ] One end-to-end trace URL printed spanning read → mint → checkout
      webhook → verify → ledger (B21).
      *Proxy:* act 1 step 9's ledger-vs-flow trace-id equality assert.
- [ ] All Phase 0 module Accept clauses green in CI (B1–B5, B6 minimal,
      B9, B12, B13 thin, B18, B20, B21, B22, B24, B27 storefront).
      *Proxy:* `pnpm -r build && pnpm -r test && pnpm lint` (unit,
      integration, property P-1..P-8 Phase 0 subset, e2e suites).
- [ ] Trio contract suite green against all three simulators.
      *Proxy:* `pnpm trio:contract-test` (42 tests, XC-7 frozen).
- [ ] Demo recorded as the asset. **Manual** — founder records
      `pnpm demo:act1` (human mode) once the gate is otherwise green.
- [ ] Later-phase modules **not started** (§0.1), save the declared
      LEAD-* long-lead exception (§7); PH1-24…26/30 only if Phase 0
      finished early (SYN-25). **Manual** — reviewed against BUILD-PLAN
      task states at the sitting.

## Run record

Appended by `pnpm gate:0 --record`; the gate sitting's human decision is
minuted here beneath the run it ratifies.
