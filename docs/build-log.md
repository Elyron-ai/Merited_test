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

---

## FND-7 — Event body schemas + catalogue (B2 pt 1) · ✅ 2026-07-04

**Built:** all 20 event bodies (§3 nineteen + `CommitmentEnded`, SYN-3) as `{type, v:1, data}` envelopes in `contracts/src/events/` (D2/D9 — type+version inside the hashed body); explicit payloads per event with golden fixtures; `LedgerEntryPosted` carries a balance refinement (Σdr = Σcr rejected otherwise); `ConversionRejected.reason_code` bound to the 12-code enum; `ErrandStateChanged.from/to` left as strings until VAL-1 lands the enum (noted for contracts-first tightening). `packages/events/src/catalogue.ts`: frozen name→schema registry + `isCatalogueEvent` guard for FND-10's append path.

**Tests:** contracts 7 files green (incl. 5 event suites: exactly-20 meta-test, per-fixture round-trips, reason-code enforcement, unbalanced-set rejection, version/type-literal rejection); events package registry tests (frozen, exactly 20, guard). Workspace build/test/lint green (exit 0).

**Deviations:** none. The "append rejects unregistered types" accept clause is FND-10's to prove — the guard it will use is tested here.

**Security self-review (ledger-adjacent):** event payloads carry no secrets (tokens appear only as claims/jti, never token strings; refresh tokens structurally absent); balance refinement prevents unbalanced ledger postings entering the chain; fixtures use fake-prefixed signatures only.

---

## FND-9 — Drizzle setup + migrations policy (D8) · ✅ 2026-07-04

**Built:** drizzle wiring in `packages/events` (`drizzle.config.ts`, `drizzle/` with `0000_baseline` + journal); forward-only runner `scripts/migrate.mjs` (refuses any role but `merited_migrate`, applies journal order transactionally, records in `events.__migrations`, checksum-guards before applying); `scripts/check-migrations.mjs` checksum guard (`db:check`, `--update` refuses modified applied files); `src/db.ts` runtime pool factory hard-asserting `merited_app`; `docs/migrations.md` policy one-pager. Root `pnpm db:migrate` orchestrates.

**Tests:** 12/12 — checksum guard (clean pass, mutation fails, new-file flagged, update-refusal), URL role assertions, integration on live Postgres: fresh DB apply → no-op re-run, wrong-role refusal, runtime `current_user = merited_app`. Workspace build/test/lint exit 0.

**Deviations:** custom Node migration runner instead of `drizzle-kit migrate` (gives us the role assertion + checksum gate in one place; drizzle-kit still generates future SQL). **Fix applied:** `init.sql` gained `GRANT CREATE ON DATABASE merited TO merited_migrate` (was missing; applied to the live volume manually — clean machines get it from init.sql).

**Security self-review (ledger DDL zone):** DDL restricted to the migrate role mechanically; runtime role asserted at pool construction; checksum guard makes applied history tamper-evident at the repo level (chain-level tamper evidence lands with FND-10/13); no secrets in migrations or logs.

---

## FND-10 — Events append core: table, hashing, chain (B2 pt 2) · ✅ 2026-07-04

**Built:** `canonical-json.ts` (RFC 8785 via json-canonicalize behind one swappable function; `assertHashSafe` rejects floats/undefined/NaN/non-plain objects pre-hash — D1); `hash.ts` (`this_hash = sha256(prev ‖ canonical_json(body))`, genesis 64×'0' — D2); `schema.ts` (drizzle def, §3 row shape); `append.ts` (`appendEvent(tx, …)` — catalogue check → Zod parse → hash-safety → `pg_advisory_xact_lock` → head read → insert in the CALLER'S transaction = transactional outbox; plus `appendEventInNewTx` convenience); `verify.ts` (`verifyChain` — gap/linkage/type-mirror/hash recompute, batched; FND-13's CLI will wrap it). Migrations `0001_events_table` (+ explicit grants) and `0002_ledger_permissions` (`REVOKE UPDATE, DELETE … FROM merited_app`) applied to the compose DB.

**Tests:** 24/24 across 6 files. Unit: canonicalisation stable across key permutations (hash-equality property), lexicographic ordering, unicode determinism, §3 formula against independent sha256 with genesis constant, float/NaN/Infinity/undefined/Date rejection. Integration (fresh DB per run): genesis prev_hash = 64×'0'; unregistered type rejected with no write; invalid payload rejected; **32 concurrent appends → gapless chain, verifyChain ok**; UPDATE and DELETE as merited_app → **42501**; admin-role tamper of a body detected by verifyChain at the exact seq. Workspace build/test/lint exit 0.

**Deviations:** none. Teardown note: test pools swallow late idle-client FATALs caused by `DROP DATABASE … WITH (FORCE)` (teardown race, not product code).

**Security self-review (ledger zone — P1):** append validates type against the frozen catalogue and body against Zod before hashing; hash-unsafe data cannot enter the chain; appends serialised via advisory xact lock (no interleaved heads); inserted body is the canonical string actually hashed; append-only enforced at the DB role level and tamper-evidence proven end-to-end (admin mutation → verify failure at seq); no secrets in event bodies (FND-7 review holds); runtime role asserted merited_app.

---

## FND-8 — Signing package: interfaces + fakes · ✅ 2026-07-04

**Built:** `Signer`/`Crypter` interfaces with hierarchy-namespaced key refs (`platform|merchant|agent`/id — SYN-1); `FakeSigner` (HMAC-SHA256, `fake-ed25519:`-tagged, timing-safe verify, secret-independent deterministic pseudo public keys); `FakeCrypter` (AES-256-GCM per (secret, keyRef)-derived key, `fake-kms:`-tagged envelopes, all failure modes collapsed into one hygienic `DecryptionError`); README stating the PH1-30/SYN-32 boundary.

**Tests:** 10/10, docker-free (D7) — determinism, own-sig verify, tampered payload/sig/keyRef rejection, cross-hierarchy rejection (merchant sig never verifies as platform), cross-secret rejection, crypter round-trip, tampered-ciphertext/wrong-key/garbage rejection, error-hygiene sweep (no secret or plaintext in any thrown error or stack). Workspace build/test/lint exit 0.

**Deviations:** none. TRIO-2 remains subsumed (SYN-1) — the trio lane builds on this package as-is.

**Security self-review (signing zone):** fakes are prefix-tagged so they can never pass for production signatures; keyRef inside the MAC input makes cross-hierarchy forgery structurally impossible; constant-time comparison; no KMS SDK dependency introduced; secrets never appear in errors (tested), and the AAD-free GCM envelope is documented as fake-only.

---

## FND-11 — Outbox delivery: LISTEN/NOTIFY + subscriber · ✅ 2026-07-04

**Built:** `pg_notify('merited_events', seq)` wired into the append transaction (fires on commit; delivery never depends on it); `deliver/subscriber.ts` — `subscribe({pool, fromSeq, handler, …})` with LISTEN as wake-up only and a cursor-ordered poll as the authoritative path; strict seq order, at-least-once semantics documented (cursor advances only after the handler resolves; caller persists the resume cursor — FND-12's cursor table builds on this).

**Tests:** 27/27 events-package total. New integration: strict-order delivery riding NOTIFY alone (poll effectively off); NOTIFY suppressed (`useListen: false`) → poll delivers within one 50ms interval; stop mid-stream → resume from `cursor()` with no gaps and no repeats.

**Deviations:** `notify.ts` folded into `append.ts` (one query in the same tx) rather than a separate file — same behaviour, less indirection.

---

## FND-13 — verify-chain CLI (B2 pt 4) · ✅ 2026-07-04

**Built:** `cli/verify-chain.ts` — `runVerifyChain()` (testable core returning `{code, output}`) + argv wrapper; events-package `verify-chain` script wired so root `pnpm verify-chain` reaches it. Prints event count + head hash; exit 1 names the first broken seq; exit 2 on connection failure.

**Tests:** 30/30 events-package total. New integration: empty ledger clean; 4-event chain → exit 0 with count + exact head hash; superuser body-tamper at seq 3 → exit 1, "CHAIN BROKEN at seq 3". Root `pnpm verify-chain` executed against the compose DB (clean).

**Deviations:** none. B2's acceptance ("hash-chain verification function + verify-chain CLI") is now fully closed; Phase-0 gate clause "chain verifies via verify-chain" has its tool.

---

## FND-6 — Vendor port interfaces (§2.2) · ✅ 2026-07-04

**Built:** `contracts/src/ports/index.ts` — `ReplayCache` (never source of truth, doc-noted), `RateLimiter`, `Mailer`, `CommerceAdapter` (normalise-only; claim building stays in MER-4's pipeline), `IdentityProviderAdapter` (authorize/exchange/refresh/userinfo/revoke), `LoyaltyLookup`, `PayoutRail` (integer-pence Money, idempotency key on transfer). Every port's doc-comment names its fake and wire-up phase per §2.2. Type-only barrel export.

**Tests:** compile-and-implement smoke test (in-memory ReplayCache/RateLimiter/Mailer exercised). Workspace build/test/lint exit 0. Also cleaned an unused import left in verify-chain.ts (caught by lint before commit this time).

**Deviations:** none. Port semantics deliberately minimal — consuming tasks refine via contracts-first PRs (per task row).
