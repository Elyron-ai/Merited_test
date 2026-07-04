# ADR-002 — ULID library and ID discipline: ulidx + typed prefixes

**Status:** accepted (week 1; XC.8 D2, SYN-4/18)

## Context

Every ID in every fixture and hash depends on the ID scheme. IDs must be
sortable, collision-safe, deterministic in tests, and self-describing on
sight in a ledger dump.

## Decision

`ulidx` with a monotonic factory (SYN-18 — over plain `ulid`). Thirteen
typed prefixes (SYN-4): `mer off com agt atk clm mnd usr evt qte apr lnk
ern`. The `Id(prefix)` helper and its Zod refinement live in
`packages/contracts` (`src/ids.ts`): `<prefix>_<26-char Crockford-uppercase
ULID>` — no I, L, O or U in the body. The deterministic test kit (XC-5,
lands after this ADR) adds a seeded monotonic factory so fixtures are
byte-stable.

## Consequences

- Any string's type is readable at a glance and machine-checkable at every
  boundary (the claims-viewer e2e caught real fixture typos exactly this
  way).
- Hand-written fixture IDs must be length- and alphabet-checked at write
  time — recorded twice in the build log; the seeded factory is the safer
  path.

**Implemented in:** `packages/contracts/src/ids.ts`; seeded factory in
`packages/contracts/src/testing/` (XC-5).
