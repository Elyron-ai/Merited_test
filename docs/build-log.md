# Merited build log

One entry per task, newest last. Format: task, what was built, test results, deviations, decisions.

---

## FND-1 — Monorepo scaffold & toolchain · ✅ 2026-07-04

**Built:** pnpm workspace with all 13 §1 members (packages/{contracts,events,signing,sdk}, apps/{core,trio,control-plane,wallet,valet,mcp-server,fake-aurora}, tools/{seed,demo}), each with ESM package.json (@merited/* scope), composite tsconfig wired into a root `tsc -b` project-reference graph, and placeholder src/index.ts. Root: package.json (scripts: build/test/lint/typecheck/db:migrate/verify-chain/projections:rebuild, packageManager pnpm@10.33.0, engines node>=22), pnpm-workspace.yaml with a version catalog (typescript/vitest/@types/node), tsconfig.base.json (strict, NodeNext, composite, verbatimModuleSyntax), eslint.config.js (ESLint 9 flat + typescript-eslint recommended), .prettierrc, vitest.workspace.ts, .nvmrc (22), .editorconfig. One smoke test in contracts proves the vitest wiring. No Turborepo (FND D5/SYN-17).

**Tests:** `pnpm i && pnpm -r build && pnpm -r test && pnpm lint` all green on this machine (Node 22.22.2, pnpm 10.33.0). Contracts smoke test: 1 passed. `tsc -b` resolves the cross-package graph (events/signing/sdk/apps → contracts).

**Deviations:** none. `packages/otel` deliberately not scaffolded — it arrives with FND-14 (SYN-2).

**Notes for later tasks:** apps/control-plane and apps/wallet are plain-TS placeholders; MER-7/PH1-9 replace their scripts with Next.js 15 when they land. pnpm build-script approvals (esbuild etc.) not needed yet — revisit if a dep requires postinstall.

---

## FND-2 — Local infra: docker-compose · ✅ 2026-07-04

**Built:** `docker-compose.yml` (postgres:16, redis:7, nsmithuk/local-kms on 4599, axllent/mailpit on 1025/8025 — healthchecks on all four); `infra/postgres/init.sql` (D8 roles `merited_migrate`/`merited_app`, six per-module schemas incl. separate `trio`, default privileges — trio tables default SELECT/INSERT only for the app role); `.env.example` with the initial `MERITED_*` set for FND-3's env loader.

**Tests:** `docker compose up -d --wait` → all four healthy. psql connects as both roles; schemas `events,core,trio,wallet,valet,control_plane` present. local-kms answers `TrentService.ListKeys` with valid JSON; mailpit HTTP 200.

**Deviations:** none in deliverables. **Environment note (sandbox only):** this remote container required starting dockerd manually with the agent-proxy env and `--registry-mirror=https://mirror.gcr.io` (the egress policy blocks Docker Hub's blob CDN). On a normal machine with Docker Desktop none of this applies — image names in compose are canonical.

**Security self-review (ledger-adjacent DDL):** roles separated per D8; app role gets no DDL; trio schema defaults exclude UPDATE/DELETE grants (FND-10's REVOKE migration still lands the explicit ledger denial); no secrets beyond dev-only passwords which are compose-local.

---

## FND-3 — Contracts primitives (B1 pt 1) · ✅ 2026-07-04

**Built:** `packages/contracts/src/{ids,money,reasons,env}.ts` + barrel. `Id(prefix)`/`newId(prefix)` over ulidx monotonic factory, 13 prefixes (SYN-4), Crockford regex validation with a typed `MeritedId<P>` template-literal type. `Money` verbatim from §3 (+`pence()` helper). `RejectionReasonCode` closed enum of the 12 §3 codes. `defineEnv(shape)` typed env loader: reads only declared keys, coerces via caller's zod shape, aggregates every missing/invalid var into one `EnvValidationError`. zod + ulidx added via the workspace catalog.

**Tests:** 16/16 green — prefix/length/alphabet rejection (incl. I/L/O/U and lowercase), 13-prefix meta-test, monotonic ordering; Money rejects floats/negatives/other currencies; reason enum exactly-12 meta-test + unknown rejection; env loader aggregates 3 problems in one throw, applies defaults, ignores undeclared vars. Workspace `pnpm -r build && pnpm -r test && pnpm lint` green.

**Deviations:** none. FND-1's placeholder smoke test replaced by the real suites.

---

## FND-5 — Contracts: 27-mechanics union (B1 pt 3) · ✅ 2026-07-04

**Built:** `src/offer/mechanics/{price,points,tier,lifecycle,access}.ts` — 10+6+3+5+3 = 27 variants exactly per D10 (7 spec-named verbatim, 20 SYN-28 proposals); one `z.discriminatedUnion('type', …)` in `index.ts`; golden fixture per variant in `fixtures.ts`.

**Tests:** 6 suites green — exactly-27 exhaustiveness meta-test, 7 spec-named presence, all-27 fixture round-trip, unknown-type rejection, ≤5-fields-per-variant meta-test, integers-only enforcement.

**Deviations:** fixtures live at `src/offer/mechanics/fixtures.ts` instead of the plan's `test/fixtures/mechanics/` so the tsc project stays rooted at `src/` — same artefacts, one file instead of 27.

---

## FND-4 — Contracts §3 object schemas (B1 pt 2) · ✅ 2026-07-04

**Built:** `Offer`, `Commitment` (+bounty-shape refinement), `AttributionTokenClaims` (qid, nullable apr), `IdentityLink` (no token fields), `OfferQuote` + `quoteExpiryWithinToken` helper, `Approval` + `approvalIsQuoteBound` helper, `ConversionClaim` (token required — SYN-5/A1), `Mandate` (incl. `pre_authorised_up_to`, SYN-15; refinements pre_auth ≤ per_txn ≤ per_month), `AgentCtx`/`ConsumerCtx`, `OrderConfirmed` (token optional). Shared `IdentityTier`. Golden fixtures with fixed hand-written ULIDs in `src/fixtures.ts` (VAL D6 discipline; reusable by seed/demo).

**Tests:** 40/40 — golden round-trip per object (11), IdentityLink key-name sweep (/token|refresh|access|secret/i → none), mandate limit-ordering refinements, commitment bounty refinement, quote-≤-token-exp and approval-quote-binding predicates.

**Deviations:** none. Note: `ConsumerCtx`/`AgentCtx` kept minimal per §4 — CORE tasks extend via contracts-first PRs if they need more signals.
