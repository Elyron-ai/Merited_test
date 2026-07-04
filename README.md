# Merited

Merited is the commerce layer for AI agents: merchants publish signed,
committed offers; registered agents read them and receive quote-bound
attribution tokens; conversions verify against a hash-chained ledger and
settle to the penny. Phase 0 runs entirely against behaviourally faithful
simulators and the FakeShop storefront of a fictional merchant, Aurora
Experiences.

## Run the demo

```sh
git clone <this repository> && cd Merited_test
pnpm install
pnpm demo:act1
```

That is the whole of it — the bootstrap checks your machine (Node 22,
pnpm, Docker), starts the local platform, applies every migration and
plays Act 1: an offer published with a signed £12.00 bounty, an agent
briefed "spa day under £120", a FakeShop checkout carrying the
attribution token, a verified claim, balanced ledger entries
(merchant −£12.00 · agent +£7.20 · Merited +£2.40 · reserve £2.40), a
statement PDF, the on-camera refusals (`TOKEN_REPLAYED`,
`QUOTE_EXPIRED`), one end-to-end trace and a verified chain head.
Artefacts land in `tools/demo/out/act1/`.

## Development

- `pnpm -r build && pnpm -r test && pnpm lint` — the standing verify loop.
- `pnpm db:migrate` — apply all Drizzle migrations to the compose Postgres.
- `pnpm seed` / `pnpm seed --reset` — the Aurora Experiences fixtures.
- `pnpm trio:contract-test` — the frozen trio contract suite (XC-7).

Canon lives in `BUILD-SPEC.md` (the brief), `BUILD-PLAN.md` (the
execution plan) and `merited-platform-architecture.md` (design
rationale), in that order of authority. Per-task history is in
`docs/build-log.md`.
