# Property-test registry (XC-6)

Every spec-demanded property (BUILD-PLAN §8, XC.4 list) mapped to the test
file that holds it. Arbitraries live in the deterministic test kit
(`packages/contracts/src/testing/arbitraries.ts`, exported from
`@merited/contracts/testing`); property runs use fixed seeds so failures
reproduce. A conventions test keeps this table's file links real — a moved
suite fails CI until the registry follows it.

| # | Property (spec clause) | Status | Test file |
|---|---|---|---|
| P-1 | Offer mechanics: all 27 variants round-trip through Zod — arbitrary mechanics → `parse(serialise(x)) ≡ x` (§5.1) | **Phase 0 — green** | `packages/contracts/src/testing/properties.test.ts` (arbitraries introspected from the union; coverage test pins all 27) |
| P-2 | Identity precedence: link beats hash; revoked link/mandate downgrades immediately; same input → same segment (§5.3) | **Phase 0 — green** | `apps/core/src/modules/identity/resolve.property.test.ts` |
| P-3 | Mandate attenuation: a child never exceeds any parent limit; widening is a validation error by construction (§6.1) | **Phase 0 — schema half green**; parent/child attenuation service property lands with the wallet mandates module (Phase 1 gate) | `packages/contracts/src/testing/properties.test.ts` (ordered limits always valid; any ordering violation refused; `arbMandateTree` ready for the Phase 1 half) |
| P-4 | Settlement trial balance: sums to zero after any generated verify/reverse/net sequence (§7.3) | **Phase 0 — green** (runs unchanged against the real service in Phase 1) | `apps/trio/src/settlement/trial-balance.property.test.ts` |
| P-5 | Approval invariants: single-use, quote-bound, `exp = quote.expires_at`, `APPROVAL_MISSING`/`APPROVAL_EXPIRED`/`LIMIT_EXCEEDED` (§6.4) | **Phase 1 gate** — Phase 0 example coverage of every reason code in the verify pipeline suites | `apps/trio/src/verification/verify.integration.test.ts` + `apps/trio/contract-tests/verify.contract.test.ts` (examples); property suite lands with PH1's approval flow |
| P-6 | Hash chain: any generated event sequence verifies; any single-byte tamper of any body or hash fails (B2) | **Phase 0 — green** (pure half in memory over the same `chainHash`/`canonicalJson` the writer uses; DB half example-tested in the append/verify integration suites) | `packages/events/src/hash.property.test.ts` |
| P-7 | Valet reducer: from every state, exactly the legal §6.6 transitions accepted, everything else rejected (exhaustive matrix) | **Phase 0 — green** (exhaustive 120-cell enumeration — stronger than sampling) | `apps/valet/src/errand/reducer.test.ts` |
| P-8 | Money: arithmetic closed over non-negative integer pence; no float ever enters a `Money` (schema + lint) | **Phase 0 — green** (schema property here; the lint half is XC-2's `no-float-currency` rule) | `packages/contracts/src/testing/properties.test.ts` |

## Conventions

- Seeds are fixed (`seed: 2026`) — a red property run reproduces exactly.
- New spec-demanded properties get a P-number here in the same PR that adds
  the suite; the registry is the map, the suites are the territory.
- Phase 1 items (P-3 service half, P-5) enter their gates' checklists
  (XC-9) — this registry is where the gate looks up their status.
