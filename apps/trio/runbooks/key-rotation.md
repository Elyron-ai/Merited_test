# Key-rotation runbook (PH1-22 · LEAD-5 audit item)

Covers the three key hierarchies of architecture §6, as actually implemented in
`packages/signing` (PH1-30) + `apps/trio/src/shared/pg-key-store.ts` (PH1-24):

| Hierarchy | Key refs | Signs | Verified by |
|---|---|---|---|
| Platform | `platform/mint` (PASETO v4.public tokens), `platform/commitments` (COR countersignature), `platform/attestations` (mandates/approvals), `platform/service` (service tokens), `platform/link_tokens` (crypter ref, not a signing key) | tokens, COR platform sig, consent attestations | trio verify pipeline, trio directory |
| Per-merchant | `merchant/<mer_…>` | COR merchant sig, conversion-claim signatures | trio verify pipeline |
| Per-agent | `agent/<agt_…>` | agent request signatures (PH1-1 canonical string) | core `AgentRequestVerifier` |

## The invariants this runbook relies on

- **Key-id convention.** A key *ref* names an identity; a key *id* names one
  keypair VERSION: `key_id = sha256(public_key_spki)[:12]`, content-derived.
  Versions live side by side in the store (`trio.signing_keys`, one row per
  version; `revoked_at` NULL = live).
- **Rotation is additive.** `Ed25519Signer.rotateKey(ref)` seals and stores a
  new version; it signs from that moment. **Verification tries every
  non-revoked version, newest first** — so artefacts signed under key N keep
  verifying after rotation to N+1 with **zero change to signature or token
  formats** (no kid in the artefact; the store carries the versions).
- **Revocation is surgical.** `revokeKeyVersion(ref, key_id)` stamps ONE
  version; everything it signed stops verifying. Sealed key material is
  immutable at the database role level — the app role can only flip
  `revoked_at` (column-level grant, migration `0004_signing_key_rotation`).
- **Custody (SYN-32).** Private keys exist at rest only AEAD-sealed under KMS
  data keys (key ref as AAD) and in memory only inside the trio process.
  Rotation never exports a key.
- Proven by: `packages/signing/src/rotation.test.ts` (signer-level) and
  `apps/trio/src/verification/rotation-tolerance.integration.test.ts`
  (simulator-level, real Ed25519/PASETO over the real `PgKeyStore`).

## 1 · Routine rotation (per hierarchy)

Cadence: platform keys **quarterly**; merchant/agent keys **annually** or on
partner request. Rotation is safe mid-traffic — in-flight tokens/CORs keep
verifying.

1. **Announce** in the ops channel: ref(s), date, operator. No partner action
   is required — formats do not change.
2. **Rotate** (inside the trio process/console):
   `await signer.rotateKey('<ref>')` → note the returned `key_id` (N+1).
3. **Verify immediately**:
   - mint a probe token / sign a probe payload → verifies (N+1 live);
   - claim a PRE-ROTATION artefact in staging → still verifies (N tolerated).
   - `SELECT key_ref, key_id, created_at, revoked_at FROM trio.signing_keys
     WHERE key_ref = '<ref>' ORDER BY id DESC;` — N+1 on top, N unrevoked.
4. **Retire N deliberately, later.** Once every artefact N signed has aged out
   (tokens: ≤10 min; CORs: their validity window; attestations: mandate/quote
   expiry), revoke it: `await signer.revokeKeyVersion('<ref>', '<key_id N>')`.
   Until then N verifies-only (it never signs again).
5. **Record** the rotation in `docs/build-log.md` (date, refs, key ids,
   operator) — LEAD-5 reviews this trail.

## 2 · Compromise path (per hierarchy)

**Trigger:** suspected private-key exposure, KMS anomaly, or a signature that
verifies but was never legitimately made.

Common first step, all hierarchies — **rotate then revoke, in that order** (so
signing never goes dark): `rotateKey(ref)`, then `revokeKeyVersion(ref, <compromised key_id>)`.
Everything the compromised version signed fails closed from that moment
(`SIG_INVALID` at verify; directory records treated as absent).

Then per hierarchy:

- **`platform/mint`** — all live tokens minted under the revoked version die.
  Blast radius: ≤10 minutes of quotes (token TTL). Agents re-read offers and
  receive fresh tokens; no data loss (quotes re-mint). Check the
  mint-vs-claim monitor for the dip and annotate it.
- **`platform/commitments` / `merchant/<id>`** — CORs countersigned by the
  revoked version stop verifying, which kills claim verification against
  them. Re-sign live commitments: `/trio/commitments` re-create from each
  offer's terms (same terms, fresh sigs), republish offers to the new CORs.
  For a merchant-key compromise also rotate the merchant's webhook secret
  (control-plane) — assume the blast radius includes it.
- **`platform/attestations`** — mandates/approvals verify via the directory;
  a revoked version makes them read as absent (claims fail
  `MANDATE_REVOKED`/`APPROVAL_MISSING` — the safe direction). Re-attest
  ACTIVE mandates from the wallet DB rows (re-sign canonical payloads);
  approvals are short-lived (quote expiry) — let them lapse.
- **`agent/<id>`** — revoke, notify the agent out-of-band, have them register
  a fresh key. Their signed requests 401 until then.
- **KMS master key** — if the KMS itself is suspect: rotate the master key in
  KMS, then rotate EVERY ref (new data keys chain to the new master), then
  revoke all prior versions. This is the full-park scenario; expect the
  re-sign work above for all hierarchies at once.

**Postmortem entry** in `docs/build-log.md` within 24h: what leaked, when
revoked, artefacts affected, monitor evidence.

## 3 · Rehearsal (before PH1-27; reviewed at LEAD-5)

- [ ] In a staging environment with real crypto (`TRIO_CRYPTO=ed25519`,
      fake-kms): run steps 1.2–1.4 against `platform/mint`,
      `platform/commitments`, one merchant key.
- [ ] Confirm a pre-rotation token claims VERIFIED post-rotation.
- [ ] Confirm a revoked version's token claims REJECTED `SIG_INVALID`.
- [ ] Confirm `verify-chain --against-heads` still passes (rotation must never
      touch the ledger).
- [ ] Time the drill; record in the build log. Target: routine rotation < 15
      minutes, compromise path < 60 minutes to revocation.

## Open items

- Native-Ed25519 KMS signing (keys never in process memory) is the recorded
  SYN-32 upgrade path — revisit at LEAD-5.
- Per-merchant webhook notice of platform rotations (informational only) can
  ride the PH1-21 head-publication webhook channel if partners ask.
