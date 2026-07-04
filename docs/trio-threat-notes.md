# Trio threat notes (TRIO-16)

Companion to [`apps/trio/HANDOFF.md`](../apps/trio/HANDOFF.md). These are the
threats the trio's design already answers, written down so the Phase 1
implementer does not undo the answer and the LEAD-5 auditor can attack it
directly. References: BUILD-SPEC §3/§7, architecture §2.2/§5/§6, principles
P1–P5.

## 1. Replay races

**Threat:** two claims carrying the same token arrive concurrently; both pass
the stage-2 read check before either records consumption, and the merchant
pays twice.

**Answer in the code:** the stage-2 `isConsumed` read is advisory only — it
exists to give the common sequential replay its verdict cheaply. The
authoritative consumption is `consumeToken` inside the SAME transaction that
stores the entry set, bumps the counters and appends `ConversionVerified`.
The `trio.consumed_jtis` primary key on `jti` makes the second transaction's
insert a conflict: it observes `consumed = false` and the verdict flips to
`TOKEN_REPLAYED` in that same transaction. There is no window in which two
verified verdicts for one `jti` can both commit. The same one-transaction
pattern covers the per-`qid` unique index (SYN-9: a re-minted approval token
and its walletless sibling cannot both convert) and double-reversal (SYN-35:
second reversal → `TOKEN_REPLAYED`).

**Auditor's attack surface:** anything that moves consumption out of the
verdict transaction, or degrades the unique constraints to application-level
checks.

## 2. Algorithm confusion / token forgery

**Threat:** JOSE-style attacks — `alg: none`, HS256/RS256 key confusion,
header-driven verification — or acceptance of a token the trio never minted.

**Answer:** PASETO v4.public is versioned and algorithm-fixed (Ed25519); there
is no algorithm header to negotiate, which is WHY the spec chose it. The
Phase 0 pseudo-token keeps every consumer honest by being opaque (`claims`
are read only from the mint response, never parsed out of the token
downstream). Defence in depth beyond the signature: a token that verifies
cryptographically but has no `trio.minted_tokens` row is rejected
`SIG_INVALID` — the trio's own mint record is the only trusted source of
token facts (SYN-8), so forging a conversion requires forging the trio's
database, not just a key.

**Phase 1 requirements:** strict single-version parsing (reject anything not
`v4.public`), library-only (`paseto`), no fallback paths, and the mint-row
check stays.

## 3. Monolith-compromise blast radius (P3)

**Threat:** the Core monolith (or the Valet, or the control plane) is
compromised; the attacker tries to mint value — fake verdicts, inflated
bounties, forged commitments.

**Answer:** the trio is architecturally isolated — own services, own schema,
own DB roles, own keys — and **verifies signatures on ALL input before
trust**, including directory records (attestations checked at the port,
TRIO-7) and merchant claims (stage 1 verifies the claim signature AND
re-verifies both COR signatures before anything else runs). A compromised
Core can submit claims, but it cannot: forge a merchant's claim signature,
resurrect an ended commitment, replay a consumed token, or write to the
trio's ledger (the events fence and DB grants stop non-trio emitters). The
worst a Core compromise buys is denial (dropping claims) — which is visible
— not fabricated money movement.

**Auditor's attack surface:** any input path into a trio service that skips
signature or attestation verification; any widening of the trio DB roles.

## 4. Merchant under-reporting (architecture §5)

**Threat:** the merchant's side simply fails to send (or selectively drops)
order webhooks, so conversions happen but claims never reach verification —
agents and the platform silently lose their commission.

**Answer today:** Phase 0 makes the behaviour rehearsable —
`FAKESHOP_DROP_WEBHOOK_PCT` drops deliveries at a configured rate, and the
adapter's retry-with-same-idempotency-key path is exercised in tests. The
ledger's append-only design means a later-arriving claim inside the
attribution window still verifies (the window, not delivery latency, is the
boundary).

**Phase 1 work:** reconciliation — compare merchant-reported order volume
against claim volume per commitment; under-reporting is a commercial-trust
problem surfaced by data, not solvable inside the trio's cryptography. Noted
for the risk register (XC-10) rather than engineered away here.

## 5. Custodied-key handover (architecture §2.2, SYN-22)

**Threat:** the custody model concentrates merchant signing authority in the
trio; a merchant leaving custody (bringing their own key) must not create a
verification gap or let old signatures become disputable.

**Answer:** signatures verify against key REFERENCES (`merchant/<mer_…>`),
never inline key material, and issuance exposes only the public half. A
handover is therefore a re-pointing of the reference to merchant-held
material for FUTURE signatures, while historical CORs and claims keep
verifying against the key versions that made them — which is why PH1-30 must
design refs to address versioned material from day one (HANDOFF §4).
Key-generation authority stays inside the trio's blast radius; nothing
outside the trio can mint a merchant key.

## 6. Key custody in process memory (recorded deviation)

Architecture §6 says "never raw keys in process"; SYN-32 records the Phase 1
deviation — Ed25519 private keys envelope-encrypted at rest via KMS data
keys, decrypted only inside the isolated trio process. Compensating controls:
the trio's process isolation (P3), keys never logged or serialised, the
high-scrutiny zone checklist on every touching PR, and the explicit upgrade
path to native-Ed25519 KMS signing (no key ever material in process). LEAD-5
ratifies or forces the upgrade before production exposure.

## 7. The audit trail itself

Every PR touching the high-scrutiny zones (trio, signing, token-client,
adapter claim-signing, ledger DDL, linking token store — XC.7) carries a
mandatory security self-review; the corresponding `docs/build-log.md`
entries carry the same section for the solo build. XC-3 auto-labels zone PRs
so the label query enumerates the complete review surface for LEAD-5. This
document plus `apps/trio/HANDOFF.md` is their starting map; the frozen
contract suite (42 tests, XC-7 zero-edit) is the behavioural baseline they
can re-run against any build.
