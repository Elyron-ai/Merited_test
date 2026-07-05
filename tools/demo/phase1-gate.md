# Phase-1 gate checklist (PH1-28 · §9 "Harden & first partners")

BUILD-PLAN §8 XC.5 / §9 Phase-1 row, restated as the working checklist.
Automated aggregate: **`pnpm gate:1`** (add `--record` to append the run's
result table to `docs/gates/phase-1.md`). The gate DECISION is human — the
aggregator proves the automatable criteria; the manual items are judged at
the gate sitting, and Phase-2 work may not start while any row fails
(§0 rule 1).

## Criteria (gate-mapping table, BUILD-PLAN §6)

- [x] **Contract suite green against the REAL trio** — the frozen 43-test
      suite, zero edits (XC-7), over real Ed25519/PASETO; simulators replaced
      file-for-file (PH1-24…26/30, SYN-32).
      *Proxy:* `MERITED_TEST_CRYPTO=ed25519 pnpm trio:contract-test`, plus the
      fake-crypto regression run.
- [x] **Mint-vs-claim monitor live** — projections rebuild to identical
      tables; the synthetic under-report fires within one projection cycle;
      the full-dress drill proves it against FakeAurora traffic (PH1-19/20/27).
      *Proxy:* analytics + monitor suites; drill inside `e2e-phase1.test.ts`.
- [x] **MCP server passes inspector** — scripted inspector over all three
      tools (PH1-6). *Proxy:* `test/inspector.integration.test.ts`.
- [x] **Mandate + approval property tests green** — attenuation can never
      escalate (fast-check, 1000+ runs); revocation is live; approvals are
      single-use and quote-bound; all four §6.4 verbatim accepts pass against
      the simulator (PH1-16/18; verification-side cases at PH1-2/26).
      *Proxy:* wallet mandate/approval suites.
- [x] **OAuth linking round-trip in CI** — wallet session → FakeAurora
      consent → callback → `IdentityLink` → live revoke; hosted fallback
      byte-compatible (PH1-10/12/13/14).
      *Proxy:* linking + hosted-linking suites.
- [x] **Walletless-T1 via `sub_hash` proven** — a non-wallet SDK agent
      presenting a link's `sub_hash` receives a T1 member-priced quote;
      revocation downgrades the next quote live (PH1-15).
      *Proxy:* `walletless-t1.e2e.test.ts` + link-resolution suite.
- [x] **Full-dress FakeAurora E2E on real rails, both flows (SYN-33)** —
      walletless + wallet-path green in CI on the real trio; §6.1/§6.4
      negatives fire on real rails; one trace ID spans each flow; the
      under-reporting drill alerts; a replayed webhook yields one claim
      (PH1-27). *Proxy:* `src/e2e-phase1.test.ts`; demo-adjacent evidence via
      `pnpm --filter @merited/demo e2e:phase1` (prints both flows' evidence
      JSON — the walletless-T1 and approval flows as assets).
- [x] **Every Phase-1 module Accept clause green in CI.**
      *Proxy:* `pnpm -r build && pnpm -r test && pnpm lint`.
- [ ] **LEAD-5 external security audit commissioned.** **Manual** — founder
      books the engagement; findings tracked to close before real-money
      exposure. The TRIO-16 audit pack, high-scrutiny register and rotation
      runbook are its inputs.
- [ ] **Key-rotation operational drill minuted.** **Manual** — the mechanics
      are proven in CI (rotation-tolerance, real crypto); the timed §3 drill
      from `apps/trio/runbooks/key-rotation.md` is run and minuted at the
      gate sitting.
- [ ] **Phase-2 modules not started (§0.1).** **Manual** — reviewed against
      BUILD-PLAN task states at the gate sitting.
