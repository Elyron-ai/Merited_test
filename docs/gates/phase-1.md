# Gate 1 — Harden & first partners (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9. The automated aggregate (`pnpm gate:1`)
is assembled during Phase 1 as its criteria's proxies land; until then this
document tracks the definition of done.

- [ ] Contract suite green against the **real** trio, unchanged from
      Phase 0 (XC-12: the same job with `TRIO_TARGET_URL` set; zero test
      edits — any edit reopens the freeze).
- [ ] Mint-vs-claim monitor live (B19 projection + per-merchant view).
- [ ] MCP server passes MCP inspector (`search_offers`, `get_offer`,
      `check_eligibility`).
- [ ] Mandate + approval property tests (P-3 service half, P-5) green —
      see `docs/testing/property-registry.md`.
- [ ] OAuth linking round-trip against FakeAurora in CI; revoked link
      resolves T2/T3 with no cache window > 5 s.
- [ ] Walletless-T1 via agent-supplied `sub_hash` proven by test.
- [ ] Refresh tokens absent from every API response, log line, and
      contract type (FND-15 lint rule + XC-13 test).
- [ ] Full-dress FakeAurora E2E live on the real trio — both flows
      (walletless + headless wallet path), failure drill detected (SYN-33).
- [ ] High-scrutiny checklists recorded on every XC.7-zone PR
      (`is:pr label:high-scrutiny` is the audit trail); LEAD-5 external
      security audit commissioned — complete before real-money exposure.
