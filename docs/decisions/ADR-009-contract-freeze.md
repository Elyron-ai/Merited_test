# ADR-009 — M1 contract freeze (XC-7)

**Status:** accepted · 2026-07-04
**Scope:** `packages/contracts` (tagged `contracts-v0.1.0`), `apps/trio/openapi.yaml` (tagged `trio-openapi-v0.1.0`), the TRIO-13 contract suite (`apps/trio/contract-tests/`).

## Context

BUILD-PLAN §4.2 week 4 ends with the M1 CONTRACT FREEZE: the trio's wire
contracts and their acceptance suite stop moving, so the Phase-1 real
implementations (PH1-24…26/30) land behind an **unchanged** suite — the
zero-edit rule. In the solo build (SYN-32) this freeze replaces the
second-builder handoff: it is what decouples the real-trio start date from
the demo ship date.

## Freeze checklist (XC-7)

| Check | Result |
|---|---|
| Trio contract suite green vs simulators | ✅ 42 tests, `pnpm trio:contract-test`, commit `743c385`. Suite is HTTP-only, `TRIO_TARGET_URL`-driven, token-opaque, public-inputs-only, with a static seam guard (`rules.test.ts`). |
| OpenAPI committed with drift gate | ✅ `apps/trio/openapi.yaml` 0.1.0, byte-identical regeneration asserted in CI-equivalent runs (`openapi.test.ts`), all 12 reason codes documented with trigger conditions (commit `189f726`). |
| High-scrutiny sign-off on the four core shapes | ✅ below. |
| D1 ratified (canonical JSON) | ✅ RFC 8785 via `json-canonicalize`, wrapped in `packages/events/src/canonical-json.ts`; integer-only numbers enforced at append time; property-tested (FND-10). Everything hashed, signed, or byte-compared in the platform goes through this one function. |
| D6 ratified (observability home) | ✅ `packages/otel` exists as the recorded smallest deviation from §1's four-package list (SYN-2); contracts stays types-only. |
| Tags | ✅ `contracts-v0.1.0`, `trio-openapi-v0.1.0`; `@merited/contracts` version bumped to 0.1.0. |

## High-scrutiny sign-off (shapes reviewed against BUILD-SPEC §3)

- **`Commitment`** — immutable COR: prefixed-ULID ids; discriminated bounty
  (`fixed` requires `amount`, `pct_of_order` requires `pct_bps`, enforced by
  refinement); all rates integer bps; terms carry both windows, tier list,
  nullable cap and validity interval; both countersignatures required;
  budget deliberately absent (SYN-12 — a Settlement counter, not a COR
  field). Signing payload convention (canonical JSON minus sig fields) is
  locked from outside by the contract suite's harness.
- **`AttributionTokenClaims`** — quote-bound v1.1 claim set: `jti/cid/qid/aid`
  prefixed ids, tier, `sid = sha256(session_nonce)` (no raw nonce), nullable
  `apr` distinguishing the two paths, integer `iat/exp`. No PII fields exist
  in the shape.
- **`ConversionClaim`** — token required (P2: no token, no bounty), order
  carries only a hash reference, integer-pence `Money`, RFC 3339 timestamp,
  merchant signature over the canonical claim.
- **`Approval`** — single-use, quote-bound (`quote_id` + `exp =
  quote.expires_at`, with `approvalIsQuoteBound` as the shared predicate),
  explicit vs pre-authorised mode, platform attestation verified before
  trust (TRIO-7's `VerifiedDirectory` is the only pipeline view).

## Post-freeze change control

1. Any change to these shapes is **contracts-first**: it lands in
   `packages/contracts` before any consumer.
2. A breaking change requires: the suite update in the SAME PR, a recorded
   high-scrutiny review in `docs/build-log.md`, and a minor-version bump +
   re-tag.
3. During PH1-24…26/30, **any** edit to `apps/trio/contract-tests/` is a red
   flag: stop, log in `docs/build-log.md`, treat as a contract bug (CLAUDE.md
   zero-edit rule). The two sanctioned harness-only extension points are the
   real-Ed25519 signer branch (PH1-30) and remote directory fixtures
   (TRIO-17) — in `harness.ts`, never in test files.

## Deferred (recorded, not blocking the freeze)

- **CI pins the suite to tagged contracts** — lands with FND-16/XC-12 (the
  CI pipeline does not exist yet in the solo build order). Until then the
  drift gates run in every `pnpm -r test` (CI-equivalent local runs).
- **TRIO-16 pack updated to the frozen shapes** — TRIO-16 is built after
  this freeze and will be written against 0.1.0 from the start.
- ADRs 001–008 (D1–D8 seed, XC-4) are back-filled by XC-4; D1 and D6 are
  ratified here because the freeze depends on them.
