# ADR-006 — Token library and the fake-token format

**Status:** accepted (week 1; XC.8 D6, SYN-32; ratified at M1 — LEAD-5
reviews the usage)

## Context

Phase 0 mints pseudo-tokens; Phase 1 mints real ones. If the two diverge in
claim shape, every consumer built against the fake breaks at the swap —
the exact failure the file-for-file replacement convention exists to
prevent. The real-implementation library must be chosen BEFORE the fake is
frozen, so the fake can mirror it.

## Decision

- Real implementation (Phase 1, PH1-25): PASETO **v4.public** via the
  `paseto` Node library — versioned, algorithm-fixed (Ed25519), no
  negotiable header (the algorithm-confusion answer; see
  `docs/trio-threat-notes.md` §2).
- Phase 0 pseudo-token:
  `v4.public.fake.<base64url(canonical_json(claims))>.<FakeSigner sig>` —
  the SAME `AttributionTokenClaims` shape (jti/cid/qid/aid/tier/sid/apr/
  iat/exp), deliberately opaque downstream: claims are read only from the
  mint response, never parsed out of the token by consumers.

## Consequences

- The contract suite's token vectors survive the Phase 1 swap unchanged
  (the zero-edit rule depends on this).
- Every consumer is honest against the real format by construction — nobody
  can have grown a dependency on decoding the token.

**Implemented in:** `apps/trio/src/verification/simulator.ts` (mint),
`verify-pipeline.ts` stage 1 (the fenced decode block —
`apps/trio/HANDOFF.md` §1); claims shape in `packages/contracts/src/token.ts`.
