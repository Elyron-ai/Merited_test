# Phase-1 hardening review pack (XC-13 · input to LEAD-5)

Assembled 2026-07-05 for the external security auditor (LEAD-5 — SYN-32's
substitute for senior-dev review). Every claim below is backed by code, a CI
test, or a runbook in this repository; file paths are the audit trail. Two
items in this pack are NOT closable by the builder and are tracked as open
founder actions: the auditor's sign-off itself (§9 Q12) and the hosting
decision (§9 Q5 / XC D-4).

## 1 · OAuth token-storage review checklist (B23, §9 Phase-1)

| # | Claim | Where to verify |
|---|---|---|
| 1.1 | Refresh/access tokens are NEVER fields on any contract type — `IdentityLink` carries `member_ref`/`sub_hash` only | `packages/contracts/src/identity-link.ts` (doc comment states the rule); lint rule 1.6 enforces it |
| 1.2 | OAuth tokens are sealed at rest: AES-256-GCM under a KMS data key via the `Crypter` port, key ref `platform/link_tokens`, stored as an opaque bundle in `wallet.link_tokens` | `apps/wallet/src/modules/linking/link-token-store.ts`; ciphertext asserted token-free in `linking.integration.test.ts` |
| 1.3 | The PKCE `code_verifier` is server-side only, single-use, TTL-bounded, bound to `state` | `apps/wallet/drizzle/0002_link_attempts.sql`; atomic consume in `link-service.ts` |
| 1.4 | Magic-link tokens: only the sha256 hash is stored; single-use + expiry checked in one atomic UPDATE | `apps/wallet/src/auth/magic-link.ts` |
| 1.5 | Tokens never appear in API responses, ledger events, or logs — asserted at three layers in CI | response/ledger/at-rest asserts in `linking.integration.test.ts`; log redaction in 1.7 |
| 1.6 | **Refresh-token-leak lint rule**: the build FAILS if `refresh_token` appears in any contract type, API response fixture, or log serialiser | `tools/lint-rules/no-refresh-token.js` (+ `tools/lint-rules/test/no-refresh-token.test.js` proving the rule bites) |
| 1.7 | Log serialisers redact token-shaped fields globally (`refresh_token`, `access_token`, api keys, auth headers) | `packages/otel/src/logger.ts` `REDACT_PATHS`; redaction round-trip in `no-refresh-token.test.js` |
| 1.8 | Hosted-linking fallback captures NO credentials — the request schema has no password field by construction; email is the only factor; token hash only at rest | `packages/contracts/src/linking.ts` (`HostedLinkStartRequest`); schema-key assert in `hosted-linking.integration.test.ts` |
| 1.9 | Directory serving (TRIO-17): consent artefacts cross service boundaries attestation-signed; the trio verifies before trust; mandates re-attested over CURRENT state so revocation is a verified live fact | `apps/trio/src/shared/ports/{directory,http-directory}.ts`; tamper + revocation cases in `apps/wallet/src/trio-directory.e2e.test.ts` |

**Auditor sign-off on token storage:** ⬜ OPEN (LEAD-5 engagement — §9 Q12).

## 2 · Key custody & rotation (SYN-32)

- Custody model: Ed25519 private keys AEAD-sealed under KMS data keys (key
  ref as AAD), decrypted only in trio process memory; versioned store with
  column-level immutability (`revoked_at` is the only app-writable column).
  Code: `packages/signing/src/{ed25519-signer,key-store,kms}.ts`,
  `apps/trio/src/shared/pg-key-store.ts`, migration `0004_signing_key_rotation`.
- Rotation: content-derived key ids; verify tries all non-revoked versions;
  compromise path revokes one version. Runbook (review item):
  `apps/trio/runbooks/key-rotation.md` — includes the per-hierarchy
  revocation/compromise paths and the timed-drill checklist (§3).
- CI proof: `packages/signing/src/rotation.test.ts` (5) and
  `apps/trio/src/verification/rotation-tolerance.integration.test.ts` (3,
  real crypto over the real store).
- Recorded deviation for ratification: keys exist in process memory while
  open (arch §6 wanted never-raw-in-process); native-Ed25519 KMS is the
  upgrade path. **LEAD-5 ratifies or requires the upgrade.**

## 3 · Hash-head publication check (PH1-21)

- Daily head anchor `{date, seq, head_hash}` to an external object store —
  first-write-wins per day (an anchor that can be replaced anchors nothing).
- `verify-chain --against-heads <dir | s3://…>` cross-checks the chain and
  fails loudly on mutation, consistent rewrite, or truncation — proven in
  `packages/events/src/head-publication.integration.test.ts` (8 cases).
- Open at go-live: real-S3 smoke test (launch-readiness A3).

## 4 · Trio audit-pack pointer

`apps/trio/HANDOFF.md` (TRIO-16) — the implementation & audit pack the
LEAD-5 engagement works from; kept honest by `src/handoff-pack.test.ts`.
High-scrutiny register: BUILD-PLAN §6 (bottom of the Phase-1 section);
security self-reviews per task in `docs/build-log.md`.

## 5 · Hosting decision (XC D-4 / §9 Q5)

⬜ **OPEN — founder.** Fly.io/Render vs AWS, forced by partner security
review before any real cutover; carries managed-Postgres PITR ("backups are
existential") and Postgres RLS belt-and-braces. The operational consequences
are pre-staged in `tools/demo/phase1-cutover-checklist.md`.

## Status

Pack assembled and CI-backed. XC-13's Accept completes when (a) the LEAD-5
auditor records sign-off on §1 here, and (b) Q5 is executed. Both tracked in
`docs/launch-readiness.md` (B11/B6) and BUILD-PLAN §9 (Q12/Q5).
