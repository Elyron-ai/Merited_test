# ADR-008 — Property-testing and determinism tooling

**Status:** accepted (week 1; XC.8 D8, SYN-19)

## Context

Retrofitting injectable time onto modules that already read the wall clock
is the expensive version of this decision. The demo must be byte-stable
across runs (D6 fixtures); settlement arithmetic must hold under generated
sequences, not just examples.

## Decision

- **fast-check** for property tests (already in use — TRIO-12's
  trial-balance suite); arbitraries for contracts types consolidate into
  the deterministic test kit (`packages/contracts/src/testing/`) when XC-5/6
  land, with the property registry documented in
  `docs/testing/property-registry.md` (XC-6).
- **Injectable `Clock`** everywhere time is read — constructor-injected
  (`TrioDeps`, Valet, harnesses); no bare `Date.now()` outside adapters.
- **Seeded randomness policy:** production code takes randomness from
  crypto APIs at well-named boundaries; tests and fixtures use the seeded
  monotonic ULID factory and fixed fixtures — no unseeded RNG in anything
  a test asserts on.

## Consequences

- The frozen clock (XC-5) makes the demo and the golden fixtures
  reproducible to the byte.
- Trial-balance and posting invariants are property-tested over generated
  event sequences (TRIO-12), not just the demo's happy path.

**Implemented in:** `apps/trio/src/shared/clock.ts` (injection point),
`apps/trio/src/settlement/trial-balance.property.test.ts` (first fast-check
consumer); the consolidated kit is XC-5/6's deliverable.
