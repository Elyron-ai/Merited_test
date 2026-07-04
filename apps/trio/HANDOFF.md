# Trio implementation & audit pack (TRIO-16)

This is the brief for Phase 1's real-implementation tasks (PH1-24, PH1-25,
PH1-26, PH1-30) and the starting map handed to the LEAD-5 external security
auditor. It states exactly which files get replaced, what every replacement
must keep behaviourally identical, and which suite is the acceptance gate.
Threat analysis lives in [`docs/trio-threat-notes.md`](../../docs/trio-threat-notes.md).

The one-sentence version: **replace three simulator files (plus one fenced
token-decode block), change nothing else, and the frozen contract suite —
`pnpm trio:contract-test`, 42 tests — must pass against the result without a
single test edit.**

---

## 1. The replacement seam — exactly which files change

| Swap unit | File | Phase 1 task | What the replacement does |
|---|---|---|---|
| Commitment signing + custodied merchant keys | `src/commitment/simulator.ts` | PH1-24 | Real Ed25519 merchant + platform countersignatures over the same canonical payloads; real custodied keypair issuance |
| Token mint + verify crypto | `src/verification/simulator.ts` | PH1-25 | Real PASETO v4.public tokens replacing the `v4.public.fake.…` pseudo-format; claims and TTL semantics unchanged |
| Settlement signature verification | `src/settlement/simulator.ts` | PH1-26 | Real Ed25519 verification of `merchant_sig` on reversal claims; every line of arithmetic unchanged |

Plus **one fenced block outside those files**: the stage-1 token decode in
`src/verification/verify-pipeline.ts` (the block guarded by the
`v4.public.fake.` prefix check, which splits the pseudo-token, base64url-decodes
the claims and verifies the FakeSigner signature) is part of PH1-25's swap
unit — it is the only place outside `simulator.ts` that knows the fake token
format. Everything else in `verify-pipeline.ts` is retained verbatim.

Beneath all three sits PH1-30: a real `Signer` implementation in
`packages/signing` (the simulators receive it constructor-injected via
`TrioDeps` — SYN-30, no ambient key material). A swap unit "changing" may in
practice mean very few lines change, because the crypto arrives through the
`Signer` port; the guarantee is directional — **nothing outside the three
files and the fenced block may change**, and any diff elsewhere during
PH1-24…26/30 is treated as a contract bug under XC-7 change control.

### Signing payloads (shared wire convention — must not change)

- `merchant_sig` is over `canonical_json(COR minus both sigs)`
  (`unsignedCommitmentPayload`).
- `platform_sig` is over `canonical_json(COR minus platform_sig, including
  merchant_sig)` (`merchantSignedPayload`) — the platform countersigns the
  merchant-signed document, so signature order is provable.
- A claim's `merchant_sig` is over `canonical_json(claim minus merchant_sig)`
  (`claimSignaturePayload`), for both verify and reverse.

## 2. Retained modules — must pass through byte-identical

| Module | What it owns (and why it is not fake) |
|---|---|
| `src/verification/verify-pipeline.ts` | The six-stage pipeline in the spec's exact order, first-failure-wins: signature chain → replay → attribution window → quote liveness → commitment terms (cap / tier / budget) → approval + mandate. Also `claims/verify` idempotency (byte-identical replay of the stored response; `422 IDEMPOTENCY_CONFLICT` on same-key-different-body) |
| `src/verification/replay-store.ts` | `jti` consumption — the `consumed_jtis` insert that makes replay protection transactional with the verdict |
| `src/settlement/posting.ts` | ALL settlement arithmetic: bounty computation, the balanced conversion/reversal entry sets (integer pence, sums to zero), commitment counters, per-month mandate spend |
| `src/settlement/statements.ts` | Statement building, period bounds, position folding, trial balance inputs |
| `src/commitment/routes.ts`, `src/verification/routes.ts`, `src/settlement/routes.ts` | Every HTTP surface, auth guard, and error mapping (`sendTrioError`: service errors carry status; malformed input is 400, never 500) |
| `src/shared/` (`deps.ts`, `server.ts`, `clock.ts`, `ports/directory.ts`) | Constructor injection (pool / signer / clock), key-ref helpers, the attestation-verified directory port (TRIO-7) |
| `src/openapi/` | The published API document — regenerated only if the contract changes, which it must not |
| `drizzle/0000_trio_tables.sql`, `0001_settlement.sql`, `0002_netting.sql` | The trio schema, roles and grants (ledger DDL is a high-scrutiny zone; no edits in this pass) |
| Every `*.test.ts` under `src/` | Integration and property tests — they run against the real implementations unchanged |
| `contract-tests/` (whole directory) | **Frozen** (M1/XC-7 zero-edit rule). Any edit during PH1-24…26/30 is a red flag: stop, log in `docs/build-log.md`, treat as a contract bug |

## 3. Fake vs real, per service

### Commitment Signing (`commitment/simulator.ts`)

- **Fake today:** the signature bytes (`FakeSigner` HMAC stand-ins) for
  `merchant_sig` and `platform_sig`; the custodied "keypair" behind
  `merchant/<mer_…>` refs.
- **Real and retained:** immutable CORs (no update path in code; the DB role
  holds no UPDATE on `trio.commitments`), `CommitmentCreated` /
  `CommitmentEnded` appended to the hash chain in the SAME transaction as the
  write, idempotent termination (`409 COMMITMENT_ALREADY_ENDED` on
  double-end), status derivation (`live` / `ended` / `not_yet_valid` /
  `expired`), counters seeded with the optional budget (SYN-12).

### Token Mint + Conversion Verification (`verification/simulator.ts` + the fenced block)

- **Fake today:** the token format — `v4.public.fake.<base64url(canonical
  claims)>.<FakeSigner sig>` — and the signature primitives at stage 1.
- **Real and retained:** the claims schema and TTL arithmetic (`exp = iat +
  min(600s, attribution_window_s)`; `422 QUOTE_EXPIRY_EXCEEDS_TOKEN` when the
  quote outlives the token); the `minted_tokens` snapshot as the ONLY trusted
  source of token facts (SYN-8 — a syntactically valid token with no mint row
  is rejected `SIG_INVALID`, i.e. forged); re-mint semantics (same `qid`,
  fresh `jti`, `apr` set); the whole six-stage pipeline; replay semantics
  (SYN-9: consumption only on a `verified` verdict, one verified conversion
  per `qid`); consume + post + counters + verdict in ONE transaction.

### Settlement (`settlement/simulator.ts`)

- **Fake today:** merchant-signature verification on reversal claims — the
  single `deps.signer.verify` call.
- **Real and retained:** everything else ("it's accounting, not crypto" —
  spec §7.3): balanced reversal entry sets, clawback windows (SYN-10:
  after-window reuses `WINDOW_EXPIRED`; a reversal frees the
  `max_conversions` counter only), SYN-35 reason-code reuse (double-reverse →
  `TOKEN_REPLAYED`; unknown claim or merchant mismatch → `SIG_INVALID`),
  netting runs, statements and the trial balance.

## 4. Key-management requirements (PH1-30, SYN-32 custody model)

- **Tokens:** PASETO **v4.public** via the `paseto` library. No JOSE/JWT, no
  algorithm negotiation anywhere (see threat notes on algorithm confusion).
- **Signatures:** Ed25519 via Node's crypto or libsodium. **Library-only
  cryptography — never hand-rolled primitives** (SYN-32).
- **Custody:** private keys envelope-encrypted at rest with KMS data keys;
  decrypted data keys and private keys live ONLY in the isolated trio
  process's memory. Never in the database in plaintext, never logged, never
  in an API response. This is a recorded deviation from architecture §6's
  "never raw keys in process"; **native-Ed25519 KMS (e.g. GCP Cloud KMS
  asymmetric signing) is the upgrade path — LEAD-5 ratifies.**
- **Hierarchy** (SYN-1, enforced by `packages/signing`'s key-ref pattern):
  `platform/mint` and `platform/commitments` (platform mint + countersign),
  `merchant/<mer_…>` (custodied merchant keys), `agent/<agt_…>`. A signature
  made under one hierarchy must never verify under another.
- **Issuance** (SYN-22): `POST /trio/keys/merchant` returns the key REFERENCE
  and the public half only; the private half never crosses the wire.
  Issuance is idempotent per merchant.
- **Rotation** is a Phase 1 work item (architecture §6): design key refs to
  address versioned material from day one; a rotation must not invalidate
  verification of historical signatures.

## 5. Running the acceptance gate (the TRIO-13 suite)

The contract suite is target-driven and lives in `contract-tests/`:

```sh
# In-process: boots the simulators against the compose Postgres.
pnpm trio:contract-test              # expect: 42 passed (42)

# Against a deployed target (XC-12 flips this to the real implementation):
TRIO_TARGET_URL=https://<target> \
TRIO_SERVICE_TOKEN=<service token> \
pnpm trio:contract-test              # expect: 34 passed, 8 skipped
```

The 8 remote skips are deliberate and documented in `contract-tests/harness.ts`:
DB-level assertions (event emission, chain verification) and directory-backed
stage-6 wallet fixtures are properties of a deployment the suite owns; every
directory-free negative (including the SYN-8 `APPROVAL_MISSING` guard) still
runs remotely. PH1-30 adds a real-Ed25519 signer branch to the HARNESS
(`MERITED_TEST_SIGNER_SECRET` selects it) — a harness change, never a
test-file change.

**Definition of done for PH1-24…26/30:** the suite passes both ways with zero
edits under `contract-tests/`, and `git diff` outside the three swap files +
fenced block is empty.

## 6. Decisions inherited (binding on the real implementation)

| Decision | One-line effect here |
|---|---|
| SYN-8 | Mint request carries a quote snapshot (`expires_at`, `mandate_ref`); the trio's own `minted_tokens` row is authoritative for every token fact; snapshot `mandate_ref` set + claim `apr` null → `APPROVAL_MISSING` |
| SYN-9 | `jti` consumed only on a `verified` verdict; one verified conversion per `qid` (unique index) — a re-minted token pair cannot double-convert |
| SYN-10 | Reversal frees the conversions counter only; after `clawback_window_s` reuses `WINDOW_EXPIRED` (the §3 enum stays closed) |
| SYN-11 | Per-month mandate spend lives in the trio's settlement counters — stage 6 reads it synchronously |
| SYN-12 | Optional commitment budget in counters; the COR itself stays immutable; feeds `BUDGET_EXHAUSTED` |
| SYN-22 | Merchant keypair issuance is a trio contract; key-generation authority stays inside the trio's blast radius (P3) |
| SYN-32 | Solo build: library-only crypto, KMS-enveloped custody, high-scrutiny self-review per PR, this pack, and the LEAD-5 audit — all complete before any real merchant, real agent money, or production exposure |

## 7. Where the threats are analysed

[`docs/trio-threat-notes.md`](../../docs/trio-threat-notes.md) — replay
races, algorithm confusion, monolith-compromise blast radius, merchant
under-reporting, and the custodied-key handover path. Read it before
touching stage 1 or the replay store.
