# Merited open verification specification

**Status:** v1.0 (PH3-7) · **Audience:** third parties with **no** Merited codebase or API access
**Goal:** given only *published head-hashes*, a *Committed Offer Record (COR)* and a *conversion proof pack*, independently verify that a specific agent-attributed conversion happened on the commercial terms the merchant committed to — offline.

This document is self-contained. Everything needed to implement a verifier is defined here: byte layouts, algorithms, encodings and the trust model. The reference verifier (`packages/verifier`, PH3-8) is built strictly against this text.

---

## 1 · Trust model

Merited's ledger is an append-only, hash-chained event log. Its integrity anchor is deliberately boring (no blockchain): **once per UTC day, Merited publishes the chain head** — the sequence number and hash of the newest event — to a public, durable object store. A published head is **never rewritten**.

What a third party can verify **without trusting Merited**:

1. **Inclusion & integrity** — a set of events is byte-for-byte what was in the ledger when a head was published (any mutation breaks recomputation; any rewrite disagrees with the externally-held heads).
2. **Commercial terms** — the COR the conversion settled against is dual-signed (merchant + platform) and immutable.
3. **Attribution** — the token presented at conversion is platform-signed, quote-bound, and names the same commitment (`cid`), quote (`qid`) and single-use id (`jti`) that appear in the ledger events.
4. **The verdict** — the `ConversionVerified` (or `ConversionRejected` + reason) event for the claim is inside the anchored slice.

Trust assumptions (explicit):

- Heads are fetched **out-of-band** from Merited's public publication location (§4). The verifier trusts that location's history, not Merited's database.
- Public keys travel **inside the proof pack** as convenience copies; their authenticity is anchored because the signed artefacts they verify (COR, token claims) are themselves embedded in ledger events covered by published heads. A pack whose keys were swapped fails anchoring: the forged artefacts' events would not hash into the published chain.

---

## 2 · Primitives and encodings

| Primitive | Definition |
|---|---|
| Hash | SHA-256; rendered as **lowercase hex** (64 chars) |
| Canonical JSON | **RFC 8785 (JCS)**. Writers additionally guarantee: no `undefined`, no non-integer numbers, no NaN/Infinity, plain objects only. A verifier only needs plain RFC 8785. |
| Signatures | **Ed25519** over the **UTF-8 bytes** of a canonical-JSON payload string |
| Signature encoding | `ed25519:` + base64url(64-byte raw signature), e.g. `ed25519:UvY…` |
| Public keys | SPKI DER, base64 (standard `-----BEGIN PUBLIC KEY-----` body) |
| Tokens | **PASETO v4.public** (Ed25519; version and algorithm fixed — no negotiable header) |
| Money | integer **pence**: `{"amount": <int ≥ 0>, "currency": "GBP_pence"}` — never floats |
| Identifiers | `<prefix>_<26-char Crockford base32 ULID>` (no I/L/O/U), e.g. `com_…`, `clm_…`, `atk_…`, `qte_…`, `agt_…`, `mer_…`, `evt_…` |
| Timestamps | ISO 8601 UTC strings in bodies; unix **seconds** integers inside token claims |

---

## 3 · The event ledger and hash chain

Each ledger event is a row:

| field | meaning |
|---|---|
| `seq` | 1-based, gapless, strictly increasing integer |
| `evt_id` | `evt_…` identifier (metadata) |
| `type` | event name (see §8 for the two conversion events a proof pack needs) |
| `body` | the **hashed** JSON document: `{"type": <name>, "v": <int version>, "data": {…}}` |
| `prev_hash` | `this_hash` of the previous row; **genesis** value for `seq` 1 is sixty-four `'0'` characters |
| `this_hash` | see formula |

The chain formula (normative):

```
this_hash = SHA256_hex( prev_hash ‖ canonical_json(body) )
```

where `‖` is plain string concatenation and the input is hashed as UTF-8. Correlation metadata (e.g. trace ids) lives **outside** `body` and is never part of the formula.

**Chain verification algorithm** — for a contiguous ascending slice of rows `e₁ … eₙ`:

1. For each `eᵢ`: recompute `SHA256_hex(eᵢ.prev_hash ‖ JCS(eᵢ.body))` and require it equals `eᵢ.this_hash`.
2. For each adjacent pair: require `eᵢ₊₁.prev_hash == eᵢ.this_hash` and `eᵢ₊₁.seq == eᵢ.seq + 1`.
3. Anchor: require the final row's `(seq, this_hash)` to equal a published head (§4).

Any mutated body byte, reordered key (post-canonicalisation), dropped row, or spliced history fails one of these three checks.

### Worked example

Body (already in RFC 8785 form):

```
{"data":{"note":"worked example","value_pence":8450},"type":"ExampleEvent","v":1}
```

With genesis `prev_hash` (64 × `0`):

```
this_hash = 0657f80deff7cc27f30e834be071fed4ae1f6a4c0d53889ead373584f9559202
```

A second event with body `{"data":{"note":"second event"},"type":"ExampleEvent","v":1}` and `prev_hash` set to the hash above yields:

```
this_hash = b8b2fcbd15d4fbbda5559e7d010dc326a66f203287a8a2cea194767362b246e6
```

A conforming implementation MUST reproduce both values exactly.

---

## 4 · Head publication

Once per UTC day, the current chain head is published as one small JSON object — **first write wins; never rewritten** (an anchor that can be replaced anchors nothing):

- Key: `heads/<YYYY-MM-DD>.json` (plus a `heads/latest.json` convenience pointer, same body)
- Body:

```json
{"date": "2027-04-01", "seq": 123456, "head_hash": "<64-hex>"}
```

The publication location is a public object-store bucket named in Merited's public documentation. A verifier SHOULD retain heads it has seen: a later disagreement between a retained head and Merited's history is proof of rewrite in itself.

---

## 5 · The Committed Offer Record (COR)

The COR is the unit of commercial truth: immutable once countersigned. Shape:

```json
{
  "commitment_id": "com_…",
  "merchant_id": "mer_…",
  "offer_ref": "off_…",
  "bounty": {"type": "fixed" | "pct_of_order", "amount": {Money}?, "pct_bps": <int>?},
  "take_rate_bps": <int ≥ 0>,
  "agent_commission_bps": <int ≥ 0>,
  "terms": {
    "attribution_window_s": <int > 0>,
    "eligible_identity_tiers": ["T1"|"T2"|"T3", …],
    "max_conversions": <int > 0> | null,
    "clawback_window_s": <int ≥ 0>,
    "valid_from": "<ISO datetime>",
    "valid_until": "<ISO datetime>"
  },
  "merchant_sig": "ed25519:…",
  "platform_sig": "ed25519:…"
}
```

`fixed` bounties carry `amount`; `pct_of_order` bounties carry `pct_bps`.

**Dual-signature byte layouts (normative):**

- `merchant_sig` is Ed25519 over `canonical_json(COR minus merchant_sig minus platform_sig)`, signed with the **merchant's** custodied key.
- `platform_sig` is Ed25519 over `canonical_json(COR minus platform_sig)` — i.e. **including** `merchant_sig` — signed with the **platform commitment** key. The countersign therefore commits to the merchant's signature.

Verify in that order with the corresponding public keys. The full COR also appears verbatim inside a `CommitmentCreated` ledger event (`body.data.commitment`), which is how a proof pack anchors it.

---

## 6 · The attribution token

Tokens are **PASETO v4.public** strings (`v4.public.<payload>`). The PASETO payload is:

```json
{"mc": { …claims… }}
```

— a single private claim `mc`; **no PASETO registered claims are used** (no `iat`/`exp` at the PASETO layer; expiry is enforced from the claims below by the verification pipeline). Claims shape:

| claim | type | meaning |
|---|---|---|
| `jti` | `atk_…` | single-use token id (replay key) |
| `cid` | `com_…` | the COR this token quotes |
| `qid` | `qte_…` | the quote that minted it |
| `aid` | `agt_…` | the registered agent |
| `tier` | `T1`\|`T2`\|`T3` | identity tier at quote time |
| `sid` | 64-hex | `sha256(session_nonce)` |
| `apr` | `apr_…` \| null | approval reference (wallet path), null on the walletless path |
| `iat` | int (unix s) | minted at |
| `exp` | int (unix s) | expiry |

**Verification:** PASETO v4.public verify against the platform **mint** public key; then parse `mc`. The claims (never the token string) also appear in a `TokenMinted` ledger event, anchoring `jti`/`cid`/`qid` to the chain.

---

## 7 · The conversion claim

The merchant-signed claim submitted at conversion:

```json
{
  "claim_id": "clm_…",
  "merchant_id": "mer_…",
  "attribution_token": "<the token, verbatim>",
  "order": {
    "order_ref_hash": "<64-hex — sha256 of the merchant's native order ref; raw refs never leave>",
    "gross_value": {Money},
    "ts": "<ISO datetime>"
  },
  "merchant_sig": "ed25519:…"
}
```

`merchant_sig` is Ed25519 over `canonical_json(claim minus merchant_sig)`, with the same merchant key as the COR.

---

## 8 · Verdicts, reason codes, and the two conversion events

The pipeline's verdict is recorded as a ledger event:

- `ConversionClaimed` — `data`: `{claim_id, merchant_id, jti, qid, cid, order_ref_hash, gross_value, ts}` (emitted at intake).
- `ConversionVerified` — `data`: `{claim_id, merchant_id, jti, qid, cid, gross_value, verified_at}`.
- `ConversionRejected` — `data`: `{claim_id, merchant_id, jti | null, reason_code, rejected_at}`.

`reason_code` is a **closed** twelve-value enum:

```
SIG_INVALID · TOKEN_REPLAYED · WINDOW_EXPIRED · COMMITMENT_ENDED ·
CAP_EXHAUSTED · TIER_INELIGIBLE · BUDGET_EXHAUSTED · MANDATE_REVOKED ·
QUOTE_EXPIRED · APPROVAL_MISSING · APPROVAL_EXPIRED · LIMIT_EXCEEDED
```

---

## 9 · The conversion proof pack

One JSON document (`merited-proof-pack/1`) bundling everything a verifier needs:

```json
{
  "format": "merited-proof-pack/1",
  "heads": [ {"date", "seq", "head_hash"}, … ],
  "cor": { …COR, §5… },
  "claim": { …conversion claim, §7 (carries the token verbatim)… },
  "keys": {
    "platform_mint_public_key": "<base64 SPKI DER>",
    "platform_commitment_public_key": "<base64 SPKI DER>",
    "merchant_public_key": "<base64 SPKI DER>"
  },
  "events": [ {"seq", "type", "body", "prev_hash", "this_hash"}, … ]
}
```

`events` is a **contiguous, ascending** slice whose **last row's `(seq, this_hash)` equals one of `heads`**, and which contains at least: the `CommitmentCreated` event for `cor.commitment_id`, the `TokenMinted` event for the token's `jti`, the `ConversionClaimed` event, and the verdict event (`ConversionVerified` or `ConversionRejected`) for `claim.claim_id`.

### Verifier algorithm (normative)

1. **Chain** — run §3's three checks over `events`; the anchor must match a head in `heads`.
2. **COR** — verify both signatures per §5 against the pack's keys; require the identical COR (byte-equal canonical JSON) inside the slice's `CommitmentCreated` event.
3. **Token** — PASETO-verify `claim.attribution_token` per §6; require `mc.cid == cor.commitment_id`; require the slice's `TokenMinted` claims to equal `mc` exactly.
4. **Claim** — verify `merchant_sig` per §7; require the slice's `ConversionClaimed` data to match the claim (`claim_id`, `jti = mc.jti`, `qid = mc.qid`, `cid = mc.cid`, `order_ref_hash`, `gross_value`).
5. **Verdict** — locate the verdict event for `claim_id` in the slice; report it (with `reason_code` if rejected).

The result is exactly one of: `VERIFIED` (all five steps pass and the verdict event is `ConversionVerified`), `REJECTED(reason_code)` (steps 1–4 pass; the ledger records a rejection), or `INVALID(step, detail)` (any check fails — including any single mutated byte anywhere in `events`, which breaks step 1).

---

## Appendix A · Development builds (non-normative)

Phase-0/demo deployments substitute two stand-ins; artefacts they produce are **not** verifiable under this spec and are recognisable structurally:

- pseudo-tokens `v4.public.fake.<base64url(canonical claims)>.<sig>` (five dot-separated segments) in place of real PASETO;
- HMAC-based fake signatures in place of `ed25519:…` ones.

A conforming verifier MUST refuse both (they fail §2's formats before any cryptography runs).
