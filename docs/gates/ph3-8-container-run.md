# PH3-8 evidence — clean-container verifier run (2026-07-05)

Gate clause: *"third party can verify a conversion from published head-hashes + a COR
without Merited access — demonstrated in a clean container with network egress disabled,
only the proof-pack files mounted; tamper test: any mutated event byte → verification fails."*

## Inputs

- `pack.json` — a REAL `merited-proof-pack/1` exported from the verifier integration
  suite's world (real Ed25519 COR signatures, real PASETO v4.public token, the trio's own
  `ConversionVerified` verdict, head published via the PH1-21 publisher). Reproduce with:
  `MERITED_PACK_OUT=<path> npx vitest run test/verifier.integration.test.ts` in `packages/verifier`.
- `trust.json` — **the out-of-band TRUST ANCHOR (HARDEN-W12/#3):** the published head(s)
  fetched from the trusted append-only heads store + the platform's public keys from its key
  manifest — `{ "heads": [{ "date", "seq", "head_hash" }], "platform": { "commitment_public_key",
  "mint_public_key" } }`. The verifier no longer trusts the pack's own `heads`/platform keys, so
  this file is REQUIRED; the auditor supplies it, never the party presenting the pack.
- `merited-verify.cjs` — the CLI bundled self-contained (no node_modules) with esbuild:
  `esbuild dist/cli.js --bundle --platform=node --format=cjs --outfile=merited-verify.cjs`.

## Run 1 — the genuine pack

```
docker run --rm --network=none --read-only \
  -v .../merited-verify.cjs:/verifier/merited-verify.cjs:ro \
  -v .../pack.json:/data/pack.json:ro \
  -v .../trust.json:/data/trust.json:ro \
  mirror.gcr.io/library/node:22-alpine \
  node /verifier/merited-verify.cjs /data/pack.json --trust /data/trust.json
```

Output (exit code **0**):

```json
{
  "outcome": "VERIFIED",
  "claim_id": "clm_01KWDFKD00EFWK4SDXDG4CV3XE",
  "verified_at": "2026-07-05T21:32:38Z"
}
```

> The `pack.json`/`node …` command is also given `--trust /data/trust.json`. Runs captured
> before HARDEN-W12 used `node … /data/pack.json` (no anchor); the outcomes below are unchanged
> — a genuine pack whose slice anchors to the trusted head still VERIFIES.

## Run 2 — one mutated event byte (`events[2].body.v: 1 → 2`), same egress-less container

Output (exit code **1**):

```json
{
  "outcome": "INVALID",
  "step": "chain",
  "detail": "seq 3: recomputed hash 6669b875… does not match this_hash — event bytes mutated"
}
```

## Notes

- `--network=none` disables ALL egress; `--read-only` proves the verifier writes nothing.
- The container never sees a database, an API, or any Merited service — only the
  read-only mounted files. The in-repo tamper matrix additionally proves EVERY event row's
  bytes are covered, plus forged claims, swapped keys, missing anchors, and structural
  refusal of dev fake formats.
- **HARDEN-W12/#3:** the trust anchor (head + platform keys) is now a SEPARATE, out-of-band
  input — the pack's own `heads`/platform keys are ignored. The suite adds a **full-forgery**
  test: a self-consistent slice that re-chains its own events, points its `heads` at its own
  forged tip and swaps in attacker keys is `INVALID` (not anchored) when verified against the
  auditor's real head — the pack can no longer self-certify. A missing anchor is fail-closed.
