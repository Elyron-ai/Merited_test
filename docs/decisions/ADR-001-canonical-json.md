# ADR-001 — Canonical JSON encoding: RFC 8785 (JCS)

**Status:** accepted (week 1; XC.8 D1, FND D1)

## Context

`canonical_json(body)` feeds the ledger hash chain and every signature
payload (commitments, claims, tokens). Every ledger row ever written depends
on the encoding; it is unfixable after the first append. Divergent
serialisation between writer and verifier would make an honest chain
unverifiable — or worse, make two different documents hash alike.

## Decision

RFC 8785 (JSON Canonicalization Scheme) via the maintained
`json-canonicalize` library — never a hand-rolled sort-and-stringify. One
function, `canonicalJson`, exported from `packages/events`
(`src/canonical-json.ts`) and used by the ledger writer, `verify-chain`, the
trio simulators and any future reference verifier alike.

On top of JCS, a hash-safety layer (`assertHashSafe`) rejects data JCS would
happily encode but Merited must never hash: `undefined` values, non-integer
numbers (the §0.4 integer-pence rule at the serialisation boundary),
NaN/Infinity, and non-plain objects.

## Consequences

- The Phase 1 real implementations and the LEAD-5 reference verifier inherit
  one encoding with library-defined semantics.
- A float can never enter the chain even if a schema misses it.
- Swapping libraries later requires byte-identical output over the recorded
  ledger — effectively never; the single-function seam exists for
  verification tooling, not replacement.

**Implemented in:** `packages/events/src/canonical-json.ts` (which cites
this ADR), exercised by FND-10's hash-chain code and its determinism tests.
