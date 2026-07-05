# PH3-8 evidence — clean-container verifier run (2026-07-05)

Gate clause: *"third party can verify a conversion from published head-hashes + a COR
without Merited access — demonstrated in a clean container with network egress disabled,
only the proof-pack files mounted; tamper test: any mutated event byte → verification fails."*

## Inputs

- `pack.json` — a REAL `merited-proof-pack/1` exported from the verifier integration
  suite's world (real Ed25519 COR signatures, real PASETO v4.public token, the trio's own
  `ConversionVerified` verdict, head published via the PH1-21 publisher). Reproduce with:
  `MERITED_PACK_OUT=<path> npx vitest run test/verifier.integration.test.ts` in `packages/verifier`.
- `merited-verify.cjs` — the CLI bundled self-contained (no node_modules) with esbuild:
  `esbuild dist/cli.js --bundle --platform=node --format=cjs --outfile=merited-verify.cjs`.

## Run 1 — the genuine pack

```
docker run --rm --network=none --read-only \
  -v .../merited-verify.cjs:/verifier/merited-verify.cjs:ro \
  -v .../pack.json:/data/pack.json:ro \
  mirror.gcr.io/library/node:22-alpine \
  node /verifier/merited-verify.cjs /data/pack.json
```

Output (exit code **0**):

```json
{
  "outcome": "VERIFIED",
  "claim_id": "clm_01KWDFKD00EFWK4SDXDG4CV3XE",
  "verified_at": "2026-07-05T21:32:38Z"
}
```

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
- The container never sees a database, an API, or any Merited service — only the two
  read-only mounted files. The in-repo tamper matrix (8-test suite) additionally proves
  EVERY event row's bytes are covered, plus forged claims, swapped keys, missing anchors,
  and structural refusal of dev fake formats.
