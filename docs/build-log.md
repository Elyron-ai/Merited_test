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

---

## FND-12 — Projections framework + rebuild runner (B2 pt 3) · ✅ 2026-07-04

**Built:** `projections/framework.ts` (`Projection` interface with `reset`; per-event apply+cursor in ONE transaction; `runProjection` live tail over FND-11; `catchUp` single-pass; `rebuildProjection` = wipe + replay from seq 0); `projection_cursors` + reference table migration (0003 — mutable by design, unlike the ledger); reference projection `events_by_type_day`; `rebuild-cli.ts` behind `pnpm projections:rebuild` (B19's analytics:rebuild aliases this pattern in Ph 1).

**Tests:** 32/32 events-package total. New integration: incremental build (7 events) vs wipe+rebuild-from-0 → **byte-identical snapshots**; cursor persisted (7) → fresh runner resumes, new event lands, cursor 8, count never double-applied. Root `pnpm projections:rebuild` runs green.

**Deviations:** rebuild uses DELETE not TRUNCATE (works within the app role's grants); projection tables live in the events schema for now — analytics (PH1-19) may move its own to a dedicated schema.

---

## TRIO-1 — Trio contract schemas · ✅ 2026-07-04

**Built:** `contracts/src/trio/index.ts` — the full M1-freeze surface: `CommitmentDraft` (unsigned, optional SYN-12 budget) + create/end req/resp; `CommitmentStatus` read (SYN-7: status, conversions_used, max_conversions, budget_remaining); `MintRequest` with the SYN-8 quote snapshot (expires_at + mandate_ref, apr optional for the B26 re-mint) and `MintResponse {token, claims}` (token-opaque downstream); `EntryLine`/`EntrySet` (balanced-set refinement, same shape as the LedgerEntryPosted body); `VerifyResponse`/`ReverseResponse` discriminated verdicts bound to the closed 12-code enum; `Balance`/`Position`/`NettingRunRequest`/`NettingRunResult`/`StatementLine`/`Statement`; the four service interfaces the simulators and PH1-24…26 both implement. Reuses FND-3's `RejectionReasonCode` and FND-7's event bodies — nothing redefined.

**Tests:** 17 golden round-trips (walletless + wallet-re-mint mint requests among them); rejected-verdict exhaustiveness over all 12 codes + unknown/missing rejection; verified-verdict requires entries_preview; no-float sweep across Money and bps fields; unbalanced EntrySet rejected; SYN-8 snapshot and non-empty nonce required. Contracts package: 67 tests green; workspace test/lint exit 0.

**Deviations:** none. This lands the freeze surface a week ahead of the calendar's M1 (end of week 4) — the change-control clock (XC-7) starts when TRIO-13's suite is green over it.

**Security self-review (trio zone):** verdict unions make an unreasoned rejection or preview-less verification unrepresentable; balance refinement blocks unbalanced previews at the schema; reason enum closed; all amounts integer pence; the SYN-8 snapshot is data the trio verifies against its own mint record (never trusted from the claim); no secrets or token internals in any schema.

---

## FND-14 — Observability package (B21) · ✅ 2026-07-04

**Built:** `packages/otel` (SYN-2's ratified layout addition) — `sdk.ts` (NodeTracerProvider, W3C propagator; exporter selection: console default / OTLP env-gated via `MERITED_OTLP_ENDPOINT` / in-memory for tests / `MERITED_OTEL=off`), `withSpan` + `injectTraceparent` + `activeTraceId` helpers, `fastify-plugin.ts` (structural typing — no runtime fastify dep; `registerTracing` + `inRequestSpan`), `logger.ts` (pino factory with trace_id/span_id mixin + FND-15 redact paths pre-wired), `register.ts` boot entry (`@merited/otel/register`; Sentry per §2.2 initialises only when `MERITED_SENTRY_DSN` is set, lazily imported).

**Tests:** harness green — service A → service B with real pg write + real ledger append on a throwaway DB: **five spans, one trace ID**, B's server span parented to A's client span; logger test proves trace_id/span_id injection and `refresh_token → [Redacted]` with no secret in the serialised line. Workspace build/test/lint exit 0.

**Deviations (recorded):** explicit propagation + span helpers instead of the plan's "auto-instrumentation for http, fastify, pg, ioredis" — ESM auto-instrumentation needs loader hooks in every app boot and is nondeterministic under vitest; the explicit pattern is what the demo trace needs and auto-instr can be layered later without contract changes. Sentry ships as a lazy optional import rather than a hard dependency.

---

## TRIO-3 — apps/trio scaffold · ✅ 2026-07-04

**Built:** Fastify host (`createTrioServer`) with timing-safe `X-Merited-Service-Token` gate on every route except /healthz (SYN-24; mTLS/signed tokens land with PH1-25); OTel tracing joined via `@merited/otel` (`registerTracing`); `Clock` port (constructor-injected — SYN-30: no env/test backdoors in the trio); migration `0000_trio_tables` creating the full §7 table set (`commitments`, `commitment_terminations`, `minted_tokens` with the SYN-8 snapshot columns, `consumed_jtis` with the SYN-9 per-qid unique, `entry_sets`/`entry_lines`, `counters`, `idempotency_keys`) with explicit REVOKE on the four append-only tables; FND-9's runner generalised (`pkgRoot`/`schema` options) so trio reuses it — root `pnpm db:migrate` now runs events then trio in topological order.

**Tests:** 5/5 integration on a fresh DB — boot + /healthz; full table set present; **UPDATE and DELETE on trio.commitments as merited_app → 42501**; auth 401/401/200; a caller's span is the parent of the server span (traceparent joined). Workspace test/lint exit 0; compose-DB migrations no-op on re-run.

**Deviations:** trio's migration runner is a thin wrapper over the generalised FND-9 runner (less duplication than the plan's per-package copy). Fixed in-test: route registration moved before first inject (Fastify freezes routes on ready); span assertion disambiguated from earlier requests.

**Security self-review (trio zone — P3):** service-token compare is timing-safe and /healthz is the only open route; append-only proven at the DB for the commitment/replay/ledger tables; the per-qid unique constraint (SYN-9) is now structural; no clock or TTL backdoor exists in the trio — deterministic time enters only via the constructor port; secrets (service token) never logged.

---

## TRIO-4 — Commitment Signing simulator · ✅ 2026-07-04

**Built:** `commitment/simulator.ts` implementing `CommitmentSigningService` (create → countersigned COR via FakeSigner with documented signing payloads — merchant over the unsigned COR, platform over unsigned+merchant_sig — persisted with counters init incl. SYN-12 budget, `CommitmentCreated` in the same tx; end → append-only `commitment_terminations` sidecar + `CommitmentEnded`, 409 on re-end; status → SYN-7 shape with live/ended/expired/not_yet_valid + counters). `routes.ts` imports only the contracts interface (the PH1-24 file-for-file seam). Signing-payload helpers exported for verification's sig-chain check (TRIO-8).

**Tests:** 6/6 integration — COR schema-valid with both sigs verifying; CommitmentCreated in the hash chain; live status with counters/budget; end→liveness-fails→409→CommitmentEnded ledgered; §5.1 bounty-edit fixture (COR1 immutable + sigs still valid after COR2 created); 404 path.

**Security self-review (trio zone):** no update path in code + DB REVOKE proven earlier; signatures cover canonical JSON so any field mutation invalidates; countersign order documented and testable; events commit atomically with writes; budget kept out of the immutable COR (counters).

---

## TRIO-5 — Token Mint simulator · ✅ 2026-07-04

**Built:** `verification/simulator.ts` mint half (`MintSimulator` implementing `TokenMintService`; verify pipeline is TRIO-8): cid liveness check via the commitment service; TTL = min(600s, attribution window); `sid = sha256(session_nonce)`; SYN-8 snapshot (`quote_expires_at`, `mandate_ref`) persisted on `minted_tokens`; opaque pseudo-PASETO `v4.public.fake.<b64url(canonical claims)>.<FakeSigner sig>`; `TokenMinted` in the same tx; re-mint = same `qid`, fresh `jti`, `apr` set. Mint REJECTS a snapshot whose `expires_at` exceeds token exp (422 — Core clamps first per CORE-10; a violating call is a caller bug). `routes.ts` mint route, interface-only.

**Tests:** 5/5 integration — claims schema-valid, sid derivation, walletless `apr: null`, ledger emission; B26 re-mint (same qid/fresh jti/apr + persisted mandate_ref); TTL capped by a 120s window; 422 snapshot-beyond-exp + 409 non-live commitment; downstream-opacity discipline (claims only ever read from the response). Workspace build/test/lint exit 0.

**Security self-review (trio zone):** tokens carry no secrets (claims are public by design; the fake sig binds them to the platform mint key); mint refuses non-live commitments and oversized quote windows; the wallet-path marker (`mandate_ref`) is recorded at mint from Core's request — verification will treat it as the trio's own record, never trusting the claim (SYN-8); nonce hashed, never stored raw.

---

## TRIO-6 — Replay store (real Postgres unique-jti logic, kept file) · ✅ 2026-07-04

**Built:** `verification/replay-store.ts` — `consumeToken(tx, {jti, qid, claim_id})` with `ON CONFLICT DO NOTHING` over the jti PK **and** the SYN-9 per-qid unique; distinguishes `replayed_by: 'jti' | 'qid'`; consumption is written in the caller's transaction so a rejected claim rolls back and never burns the token (SYN-9). This file is production code — retained through the PH1-25 swap; the Redis fast-path in front is PH1-25 hardening, never authoritative.

**Tests:** 4/4 integration on real Postgres — sequential replay by jti; **16 parallel consumptions → exactly 1 consumed, 15 replayed**; re-minted token (same qid, fresh jti) blocked by qid (the double-bounty path is structurally closed); rollback-leaves-consumable (rejected claims don't burn). Workspace test/lint exit 0.

**Security self-review (trio zone):** replay decision rests solely on Postgres unique constraints (no read-then-write race — conflict resolution is the constraint itself); both replay dimensions covered; consumption atomicity with the verdict guaranteed by transaction scope; no trust in caller-supplied state beyond the ids being consumed.

---

## TRIO-7 — TrioDirectory port + fakes · ✅ 2026-07-04

**Built:** `shared/ports/directory.ts` — the `TrioDirectory` port (getApproval/getMandate), `attest()` helper (platform attestation over the canonical record minus its attestation field), `VerifiedDirectory` wrapper (the ONLY view the pipeline uses — invalid attestation ⇒ record treated as absent, P3), and the mutable `FixtureDirectory` fake with live `revokeMandate` so the full stage-6 pipeline is testable before B14/B26 exist. TRIO-17 swaps the inner port for the wallet HTTP client with zero pipeline changes.

**Tests:** 7/7 — attested round-trips; tampered attestation → absent; tampered body under old attestation → absent; wrong-hierarchy attestation → absent (SYN-1); live revocation visible on next read; unknown ids null; port swappability proof.

**Security self-review (trio zone):** the pipeline can only see attestation-verified records; body and attestation are bound via canonical JSON; hierarchy namespacing enforced; revocation is read live, never cached.

---

## TRIO-9 — Double-entry posting engine · ✅ 2026-07-04

**Built:** `settlement/posting.ts` — pure `bountyFor` (fixed / pct_of_order with floor), `splitBounty` (floor + remainder-to-reserve: balances by construction), `conversionEntrySet` (the four-line balanced set, entry_set_id deterministic from claim); `storeEntrySet` (persist + `LedgerEntryPosted` in the caller's tx); counters per architecture §2.2 (`applyConversionCounters` — used+1, budget decrement; `recordMandateSpend`/`mandateMonthSpend` for the per-month limit, SYN-11). Migration `0001_settlement`: `mandate_month_spend` + a **deferred constraint trigger** so an unbalanced entry set fails at COMMIT in Postgres itself.

**Tests:** 9/9 (4 pure + 5 integration) — the demo's canonical numbers exact (1200 → 720/240/240, trial balance zero); floor/remainder property across awkward bps; pct_of_order flooring (8450 @ 500bps → 422); unbalanced insert **rejected by the DB trigger with full rollback**; counters and month-spend accumulation. This file is production code (retained per TRIO-16/§7.3).

**Security self-review (trio zone — P1):** split arithmetic is integer-only and locked by the demo numbers; balance enforced at two layers (schema refine + DB trigger); counters mutate only through dedicated functions inside the verdict transaction; rounding remainder always lands in reserve (never platform or agent — no silent skim).

---

## TRIO-8 — Conversion Verification simulator (the six-stage pipeline) · ✅ 2026-07-04

**Built:** `verification/verify-pipeline.ts` (re-exported through `simulator.ts` — the PH1-25 swap unit): first-failure-wins through the spec's exact order — (1) signature chain: merchant sig on claim → platform sig on token → both COR sigs, with the trio's own `minted_tokens` row authoritative for token facts (SYN-8; absent row = forged); (2) replay read-check; (3) attribution window; (4) quote liveness from the minted snapshot; (5) COR validity (SYN-34) → cap → tier → budget; (6) wallet-path-only approval checks incl. the SYN-8 guard (mandate_ref minted + apr null → APPROVAL_MISSING), approval quote-binding/expiry, live mandate status, per_txn AND cumulative per_month limits. Verified: consume jti + post entries + counters + mandate spend + `ConversionVerified` in ONE transaction; concurrent-duplicate losers get TOKEN_REPLAYED from the constraint. §8 idempotency: same key → stored byte-identical verdict without re-execution; same key/different body → 422. `ConversionClaimed` is never emitted here (SYN-6). Verify route registered; `claimSignaturePayload` exported for MER-4.

**Decision (SYN-34, appended to plan §3 in this commit):** `/end` stops new mints, not in-flight tokens — §5.1/arch §2.2 govern over a literal stage-5 reading; `COMMITMENT_ENDED` = claim outside the COR's validity window. The plan's matrix row was corrected; both directions are tested.

**Tests:** 16 new (51 trio total) — happy path with preview==persisted line-for-line + counters + ledger; ALL 12 reason codes induced from public inputs; multi-failure ordering (window beats quote); SYN-34 both ways; idempotent replay byte-identical with no re-posting; ≥10 distinct reason codes present in ConversionRejected ledger events. Workspace build/test/lint exit 0.

**Security self-review (trio zone — the crown jewel):** the trio trusts only verified signatures and its own records (mint row, counters, month spend); every rejection is first-class ledger data; consumption is atomic with the verdict so no state mutates on a rejected claim; approval/mandate records reach the pipeline only through the attestation-verifying directory; idempotency responses are stored verdicts, not re-computations; no test backdoors — every negative case is public-input-induced (SYN-30 held).

---

## TRIO-10 — Clawback reversals · ✅ 2026-07-04

**Built:** `settlement/simulator.ts` (`SettlementSimulator`, the PH1-26 swap unit — the ONLY fake part is FakeSigner merchant-sig verification; TRIO-11 fills in positions/netting/statements, stubbed 501 for now) + retained arithmetic in `posting.ts`: `reversalEntrySet` (exact side-flip of the posted set — same accounts/amounts, so per-account net effect is zero), `loadEntrySet` (re-hydrate from the trio's own ledger rows), `freeConversionCap` (SYN-10: reversal frees `max_conversions` — and ONLY that counter; budget spend and mandate month spend stay consumed). `POST /trio/claims/reverse` registered interface-only (`registerSettlementRoutes`). Check order mirrors verify: merchant sig → trio-records lookup (consumed claim + COR owner match) → double-reverse → clawback window (`clock.now() ≤ consumed_at + clawback_window_s`) → transactional post (reversing set + freed cap + `ConversionReversed`, one tx). The deterministic `set_rev_<claim_id>` entry-set PK is the concurrency arbiter — the loser's tx rolls back whole and maps 23505 → `TOKEN_REPLAYED`. Reversal entries are ordinary un-netted rows, so a post-netting reversal lands in the open period by construction (TRIO-11's marker table never touches them retroactively).

**Decision (SYN-35, appended to plan §3 in this commit):** double-reverse reuses `TOKEN_REPLAYED`; unknown claim / merchant mismatch / bad sig reuse `SIG_INVALID` (trio records authoritative, absent = untrusted — verify stage-1 pattern). Enum stays closed per SYN-10.

**Tests:** 7 new (58 trio, workspace 169) — Accept clause verbatim: within-window → balanced reversing set with preview==persisted and per-account net zero across both sets; after-window → `WINDOW_EXPIRED` with nothing posted and counter untouched; double-reverse → `TOKEN_REPLAYED`, cap freed exactly once; ledger rows reject UPDATE/DELETE at the DB (42501). Plus: SYN-10 end-to-end (CAP_EXHAUSTED commitment reopens after reversal, next mint verifies); 8-way concurrent reverse → exactly one wins; cross-merchant reversal with a correctly-signed foreign key → `SIG_INVALID`; budget explicitly NOT restored (locks the SYN-10 cap-only reading). Workspace build/test/lint exit 0.

**Security self-review (trio zone):** inputs Zod-parsed and signature-verified before any record is trusted; the reversal is derived from the trio's own posted lines, never from caller-supplied amounts; window uses the injected clock against the DB's `consumed_at` (no caller timestamps); posting + counter + event are atomic, so a lost race mutates nothing; append-only holds at the DB for reversal rows; no secrets or keys logged; replay of a reversal is structurally impossible (PK), not just checked.

**Deviation/notes:** none against the task row. Reversal deliberately does not restore budget or mandate month spend — SYN-10 names only the cap; revisit only via a founder decision (would be a new SYN row).

---

## TRIO-11 — Netting, positions, statements · ✅ 2026-07-04

**Built:** `settlement/statements.ts` (RETAINED module per TRIO-16): party↔account mapping (SYN-36), signed-balance fold (`credit positive; ≥0 receivable / <0 payable`), `livePosition` (Σ of the party's account lines), `buildStatement` (opening = pre-period lines; period entry lines with seq + UK-English descriptions; netting events touching the party; closing = opening + period lines — netting moves nothing, SimulatedPayouts is statements-only per spec §2.2), `statementHtml` + `renderStatementPdf` via playwright-core/Chromium (spec §7.3's Playwright path; `executablePath` injectable for environments with a pre-installed browser — no ambient env reads inside the trio). `simulator.ts`: `runNetting` (claims every un-netted entry set via the append-only `netted_sets` PK inside one tx — concurrent runs partition rather than double-count; folds to per-party positions; emits `SettlementNetted`), `position`, `statement`. Migration `0002_netting` (`netting_runs` + `netted_sets`, GRANT INSERT/SELECT only + explicit REVOKE UPDATE/DELETE). Routes: `POST /trio/netting/run`, `GET /trio/positions/:party`, `GET /trio/statements/:party/:period` (+`/pdf`, rendered from the retained module — the seam guard's intent is "no simulator imports in routes", which holds). Contracts-first change: `Statement.netting_events` added (pre-M1-freeze; the plan row requires netting events in statement JSON; golden fixture updated in the same commit).

**Decision (SYN-36, appended to plan §3 in this commit):** party strings = `mer_*`/`agt_*` ids, `platform`, and `reserve` as the single holding party; zero folds omitted from run positions; credit-positive signed convention.

**Tests:** 6 new (64 trio; 175 workspace) — Accept clause verbatim: Act-1 fixture netting run yields exactly `agt +£7.20 / mer −£12.00 / platform +£2.40 / reserve +£2.40` (demo step 6 numbers) with the same positions in the `SettlementNetted` ledger event; positions endpoint agrees with statement closing for all four parties (and live positions sum to zero); statement JSON snapshot-tested with normalised ULIDs/timestamps; PDF smoke-tested (`%PDF-` header, >1kB, contains the party name — no byte-snapshotting). Plus: re-run with nothing un-netted → empty positions; reversal of an already-netted conversion folds into the next (open) period as the exact mirror-image positions; malformed period → 400 `INVALID_PERIOD`; unknown party → zero receivable; netting tables reject UPDATE/DELETE at the DB (42501). Workspace build/test/lint exit 0.

**Security self-review (trio + ledger-DDL zones):** netting never mutates entries — marker rows only, enforced by REVOKE at the role level; the `netted_sets` PK makes double-netting structurally impossible under concurrency; period input validated (closed regex) before touching SQL; all SQL parameterised; statement HTML escapes party/description strings (they transit merchant-supplied ids); PDF rendering happens on trusted, already-persisted ledger data only; no secrets or keys logged.

**Deviation/notes:** playwright-core pinned at ^1.61; environments whose installed Chromium revision differs pass `executablePath` (the sandbox uses `/opt/pw-browsers/chromium`). The PDF title is ASCII-only so the party name is greppable in the PDF's plain-text metadata (em-dash titles get UTF-16-encoded by Chromium — found and fixed by the smoke test).

---

## TRIO-12 — Trial-balance-zero property suite · ✅ 2026-07-04

**Built:** `settlement/trial-balance.property.test.ts` — fast-check (v4) generator over arbitrary interleaved sequences (1–10 ops) of commitment-create / mint / verify / reverse / netting-run, valid AND invalid inputs deliberately mixed: fixed and pct bounties, tiny/huge attribution and clawback windows, restricted tiers, small caps and budgets, not-yet-valid commitments, tampered signatures, replayed tokens (organic — token indices repeat), unknown/wrong-merchant reversals, malformed netting periods. Runs against the HTTP surface (Fastify inject with the service-token gate live and all four route modules registered), so the identical property gates PH1-24…26 with zero edits. Model state and the database accumulate across runs — the invariant must hold over all history, not a clean slate. After every sequence: Σ(debits) − Σ(credits) across all accounts = 0, and `GET /trio/positions/:party` equals the per-party fold of raw entry lines for every party seen. Any 5xx fails the property. On failure the shrunk counter-example (+ seed and replay path) is written to `src/settlement/__fixtures__/trial-balance.counterexample.json` per the Accept clause.

**Tests:** 1 property × 500 generated sequences (~12.6s; the Accept's ≥500 asserted on `numRuns` inside the test). Workspace 176 tests, build/test/lint exit 0.

**Security self-review (trio zone):** the suite is adversarial by construction — forged signatures, replays, cross-merchant reversals and malformed inputs are generated continuously and the books must stay balanced through all of them; everything is induced via public HTTP inputs (no clock or DB backdoors, SYN-30 held); the service-token gate stays enabled during the property run.

**Deviation/notes:** fc counter-example replay is advisory when state accumulates (a re-run with the same seed starts from different DB state) — acceptable because the invariant is state-independent; noted for TRIO-13's harness docs. fast-check 4.x renamed `error` → `errorInstance` on RunDetails (caught by tsc).

---

## TRIO-13 — Exhaustive contract test suite + harness (the M1 acceptance gate) · ✅ 2026-07-04

**Built:** `apps/trio/contract-tests/` — 42 tests in five files, all driven by `TRIO_TARGET_URL`. `harness.ts` resolves the target: unset → boots the simulators in-process against docker-compose Postgres (fresh DB) behind a real `app.listen` socket; set → the SAME tests hit that base URL over fetch with zero test edits (spec §7 accept). Simulator code loads only behind the in-process branch (dynamic imports) — a remote run never touches `apps/trio/src`. The harness re-declares the wire conventions from the OUTSIDE (merchant key refs, canonical-JSON-minus-sig claim payloads) so the suite locks them independently of the implementation; response parsing goes through the contract Zod schemas (`asCommitment`/`asMint`/`asVerify`/`asReverse` — the schemas are the assertions). `commitment.contract.test.ts` (COR countersigning, immutability incl. no PUT/PATCH surface, /end once → 409, liveness states, mint gates, the transport token gate, healthz). `verify.contract.test.ts` (opaque tokens — claims only from mint responses; all 12 reason codes via public inputs with a `seen`-set exhaustiveness proof over the closed enum; pipeline ordering; SYN-34 both ways; re-mint B26 incl. the strict one-per-qid proof under a valid approval; §8 idempotency byte-identity + 422 conflict; wallet path happy/negative via directory fixtures, run-time-skipped on remote targets pending TRIO-17). `settlement.contract.test.ts` (reversal set exactness via HTTP position deltas, zero-window WINDOW_EXPIRED from public inputs, double-reverse, SYN-10 cap reopen, netting fold + fold-exactly-once, mirror-image open-period reversal, statement-vs-position agreement, PDF smoke, invalid periods). `events.contract.test.ts` (DB-gated: all eight moat events present + `verifyChain` green end-to-end). `rules.test.ts` — the CI seam guard, statically enforced: no `routes.ts` imports a simulator; contract tests import ONLY packages + harness; harness keeps simulators behind the dynamic branch. Scripts: `pnpm trio:contract-test` (root) → typecheck (`contract-tests/tsconfig.json`) + run.

**Gap-sweep findings, fixed in the same commit (both in the high-scrutiny zone):**
1. *Idempotent replays were not byte-identical* (§8/D7): the stored snapshot is canonical JSON but first responses used Fastify's key order. The verify route now serialises every verdict canonically on the wire, so fresh and replayed bytes match exactly.
2. *Malformed public input returned 500*: route Zod failures fell through to Fastify's default handler. New shared `sendTrioError` in retained `shared/deps.ts` maps ZodError → 400 `VALIDATION_FAILED` across all four route modules; service errors keep their own statuses.

Also: `TRIO-2` marked subsumed by FND-8 in the plan (SYN-1 — the §2 key already said so; the row was never state-marked).

**Tests:** 42 contract tests green via `pnpm trio:contract-test`; workspace 218 tests green (trio 107 — the contract suite also runs under plain `pnpm -r test`); build + lint exit 0.

**Security self-review (trio zone — this suite IS the gate):** every negative is induced from public HTTP inputs (no clock or DB backdoors; the zero-window clawback negative uses a real elapsed wall-clock); tokens are opaque throughout; the transport auth gate is asserted on; the exhaustiveness test fails if any of the 12 closed-enum codes was never induced; the seam guard makes simulator leakage into routes or tests a CI failure, not a review catch; both gap-sweep fixes tighten the public surface (byte-stable idempotency, no 500s from crafted input). From here the suite is FROZEN under XC-7 change control — any edit during PH1-24…26 is a contract bug to stop and log, not a test to fix.

**Deviation/notes:** wallet-path fixtures and DB-backed event assertions skip at run time against remote targets (directory arrives with TRIO-17; a remote ledger is not the suite's to open) — recorded for TRIO-16/HANDOFF. PH1-30 will add a real-Ed25519 signer branch to `harness.ts` (a harness change, never a test-file change).

---

## TRIO-14 — OpenAPI docs · ✅ 2026-07-04

**Built:** `apps/trio/src/openapi/document.ts` — the trio's OpenAPI 3.0.3 document generated with zod-to-openapi (v7, zod-3 line) from the SAME `packages/contracts` Zod schemas the routes parse, committed as `apps/trio/openapi.yaml` (deterministic YAML; `pnpm --filter @merited/trio openapi:generate` regenerates). Documents all eleven endpoints, the normative six-stage pipeline order with first-failure-wins semantics (SYN-2), all 12 reason codes with their exact trigger conditions — via a `Record<RejectionReasonCode, string>` that is compile-time exhaustive over the closed enum (a 13th code fails the build until documented) — plus idempotency byte-for-byte semantics (§8/D7), re-mint/one-per-qid (SYN-9), clawback semantics (SYN-10/35), SYN-34's /end reading, the SYN-36 party mapping, and the SYN-24 transport gate as a securityScheme. `openapi.test.ts` is the drift gate: the committed yaml must equal the regenerated string byte-for-byte in CI-equivalent runs, every enum member must appear, every endpoint must be present.

**Tests:** 3 new (trio 110; workspace 221 green, build/lint exit 0). Accept clause held: byte-identical regeneration asserted; all 12 `RejectionReasonCode` members verified present in the verify response docs.

**Deviation/notes:** none. The version is pinned 0.1.0 to be tagged by XC-7 (M1 freeze) alongside `@merited/contracts@0.1.0`.

---

## XC-7 — M1 CONTRACT FREEZE · ✅ 2026-07-04

**Done:** `docs/decisions/ADR-009-contract-freeze.md` records the completed freeze checklist: trio contract suite green vs simulators (42 tests, TRIO-13); OpenAPI 0.1.0 committed with its byte-identical drift gate (TRIO-14); high-scrutiny sign-off on the four core shapes (`Commitment`, `AttributionTokenClaims`, `ConversionClaim`, `Approval` — each reviewed against BUILD-SPEC §3, notes in the ADR); D1 (RFC 8785 canonical JSON) and D6 (`packages/otel`) ratified. `@merited/contracts` bumped 0.0.0 → 0.1.0; annotated tags `contracts-v0.1.0` and `trio-openapi-v0.1.0` created on this commit. Post-freeze change control is stated in the ADR and mirrors CLAUDE.md's zero-edit rule: contracts-first PRs, suite update in the same PR, recorded high-scrutiny review, minor-version bump. **From this commit, the zero-edit rule is ACTIVE** — the two sanctioned harness-only extension points (PH1-30 signer branch, TRIO-17 remote directory fixtures) live in `harness.ts`, never in test files.

**Deferred, recorded in the ADR:** CI pinning of the suite to tagged contracts lands with FND-16/XC-12 (no CI pipeline exists yet in the solo order — the drift gates run in every `pnpm -r test` until then); TRIO-16 will be written against the frozen 0.1.0 shapes; XC-4 back-fills ADR-001…008.

**Tests:** workspace 221 green after the version bump; build/lint exit 0. Milestone: **real-trio Phase-1 work (PH1-24…26/30) is now unblocked** against frozen contracts.

**Addendum (XC-7):** the annotated tags `contracts-v0.1.0` / `trio-openapi-v0.1.0` exist locally on commit `45a5aa7`, but pushing tag refs is denied (HTTP 403) — this build session's repository access is scoped to the working branch only. The freeze commit itself is pushed; the tags can be pushed by anyone with full repo access, or recreated verbatim: `git tag -a contracts-v0.1.0 45a5aa7 -m "M1 freeze: @merited/contracts 0.1.0 (ADR-009)"` (same for `trio-openapi-v0.1.0`). Recorded here so the M1 record is complete.

---

## CORE-1 — Core app skeleton · ✅ 2026-07-04

**Built:** `apps/core/` per §1. `src/server.ts` — Fastify with the Zod type-provider (`fastify-type-provider-zod` v4 compilers), FND-14 tracing, and the §1 structured error envelope via `plugins/validation.ts`: schema-invalid requests → 400 `VALIDATION_FAILED` with the raw Zod issue list; `CoreHttpError` carries `{code, message, reason_code?}`; anything unexpected is an opaque 500 (internals never reach the wire — tested with a deliberately leaky error). `src/env.ts` — typed fail-fast loader (`MERITED_DATABASE_URL`, `MERITED_REDIS_URL` required, port defaulted/coerced). `src/db.ts` — merited_app role-asserted pool (D8) wrapped in drizzle; `drizzle.config.ts` + the generalised forward-only runner wired for the `core` schema (no-op until CORE-2 lands 0000). Full module tree frozen day one: `modules/{offers,identity,eligibility,decisioning,guardrails,agents,merchants,adapters,analytics,token-client,quotes}/` with task-pointer stubs (quotes per SYN-14). `modules/adapters/rate-limiter/`: `RedisRateLimiter` (fixed window INCR + first-hit EXPIRE over the contracts `RateLimiter` port; **fails open** on Redis failure — Redis is never a source of truth, limits are throttles not authorisation) and `InMemoryRateLimiter` (injected clock) as the unit fake. `src/main.ts` boot entry (otel register first, env, DB reachability probe, listen, signal shutdown); `pnpm --filter @merited/core dev` runs it via tsx with compose-local env inline.

**Accept clause proven live, not just in tests:** dev boot against docker-compose → `/healthz` 200 `{ok:true,service:'core'}`; boot with no env fails naming BOTH missing vars; `db:migrate` no-ops cleanly; schema-invalid request → structured 400 with Zod issues (also covered in the suite).

**Tests:** 13 new (5 files) — envelope behaviour (invalid/valid/CoreHttpError/leak-proof 500), env fail-fast + coercion, in-memory limiter window semantics with injected clock, Redis limiter against compose (allow/deny/TTL/key isolation + fail-open against a dead Redis), db role assertion + live query. Workspace 234 tests green; build/lint exit 0.

**Deviation/notes:** none beyond the row. Dependencies added: `fastify-type-provider-zod@^4` (zod-3 line), `ioredis`, `tsx` (dev, per D5), `drizzle-orm`/`drizzle-kit` (catalog). Rate-limit key conventions (per-agent vs per-IP) land with CORE-3 as the plan specifies.

---

## CORE-2 — Offers storage + CRUD service · ✅ 2026-07-04

**Built:** migration `apps/core/drizzle/0000_offers` — ONE `core.offers` table with the mechanics union as jsonb (§5.1: "do not build 27 tables"), `core.offer_counters` (read-model outside the immutable COR; never the enforcement point) and `core.offer_commitments` (COR history link, "history preserved"). Explicit app-role grants (SELECT/INSERT/UPDATE, no DELETE). `modules/offers/schema.ts` (drizzle defs), `repository.ts` (insert+counter row in one tx; guarded `setStatus` transition primitive; `commitmentHistory`; the `OfferMechanics` union validates at BOTH boundaries — writes via `Offer.parse` before insert, reads via `Offer.parse` on the way out so a hand-edited row cannot leak), `service.ts` (createDraft / update / pause / end / list / get with `CoreHttpError` 404/409 semantics; offers stay editable until ended — only bounty changes cycle the COR, via CORE-5's editBounty). No HTTP surface, per the row.

**Tests:** 6 new (apps/core 19; workspace 240) — the Accept verbatim: **all 27 `MECHANICS_FIXTURES` variants insert → select → `Offer.parse` → deep-equal** (fixture count asserted = 27); union rejection at the write boundary (unknown discriminant AND float pence inside a valid discriminant); full lifecycle with guarded transitions (pause requires live; end terminal; ended uneditable); update re-validates mechanics; merchant/status list filters; 404s; counters start at zero. Build/lint exit 0.

**Deviation/notes:** `setStatus` initially used a raw `= ANY($param)` SQL fragment — drizzle serialises JS arrays incorrectly for that shape (pg 22P02); switched to drizzle's `inArray`. Service `update` allows draft/live/paused edits (not just draft) to honour §2.2's "offers stay freely editable"; recorded here as the intended reading of "create/update draft".

---

## CORE-3 — Agent Registry · ✅ 2026-07-04

**Built:** migration `0001_agents` — `core.agents` + `core.agent_keys` (SHA-256 `key_hash` UNIQUE, `key_last4` for display, `alg`/`public_key` as the built-not-implemented Phase-1 Ed25519 upgrade path — no signing code, per §2.1 B4). `modules/agents/keys.ts`: `mak_` + 256-bit base64url key generation, digest-only storage, `hashesEqual` constant-time comparison. `service.ts`: `register` (agent + key row + `AgentRegistered` into the hash-chained ledger, one transaction; the clear key exists exactly once, in the response), `authenticate` (hash presented key → indexed digest lookup joined to live-key + active-agent conditions → constant-time digest compare; returns null, never throws, for bad credentials), `revokeKeys` (effective immediately — nothing cached). `auth.ts` Fastify plugin with the B4-critical split: **absent** `X-Merited-Agent-Key` → anonymous ctx `{agent_id: null}` (degraded read, NOT 401); **present-but-invalid** → 401 `AGENT_AUTH_FAILED`; then per-agent rate limiting (per-IP when anonymous, §8) → 429 + `Retry-After` via the CORE-1 `RateLimiter` port. `routes.ts`: open, IP-rate-limited `POST /v1/agents/register`. `inTx` helper added to `db.ts`.

**Tests:** 7 new (apps/core 26; workspace 247) — Accept coverage: key hashing (format, determinism, digest-not-key stored), constant-time compare semantics, revocation on the very next request, and 429s with Retry-After on BOTH the open register route (IP-keyed) and the authed surface (agent-keyed). Plus the B4 header split (absent → `{agent_id:null}` 200; invalid → 401; valid → agent ctx) and the `AgentRegistered` ledger event. The full unregistered-read e2e (`token: null` + `register_to_earn`) asserts in CORE-14 as planned. Build/lint exit 0.

**Security self-review (credential handling, beyond the formal XC.7 zones):** clear keys never stored, logged, or echoed after the registration response; hashes compared constant-time; auth failures are uniform 401s (no user/key distinction leaks); revocation and suspension are read live per request; registration and authenticated surfaces are rate-limited with separate buckets; the reserved `public_key` field is stored inert — no verification path exists yet, so it cannot be a bypass.

---

## CORE-4 — Identity Resolution · ✅ 2026-07-04

**Built:** `modules/identity/resolve.ts` — PURE `resolve(consumer, lookups, clock)` → `{tier, identity_ref, segment}`: precedence is the first ACTIVE member match in signal order consumer_ref → sub_hash → member_ref → T1 (link beats hash); else hashed-email soft-identity match → T2; else T3. A `revoked` member row never resolves T1. `segmentFor` maps deterministically onto the new FROZEN `Segment` enum in `packages/contracts` (contracts-first; additive — the M1-frozen trio shapes untouched): 7 values, T1 × {gold,member} × {new,returning}, T2 × {new,returning}, `t3-acquisition`. "Returning" is a pure function of the soft-identity row (seen more than once: `first_seen_at ≠ last_seen_at`). Migration `0002_identity`: `core.aurora_club_members` (Phase-0 T1 stand-in — schema CORE owns, rows VAL-9 owns) + `core.soft_identities` (hashes only, no raw identifiers). `store.ts` (`IdentityStore`): all lookups fetched live (no caching — revocation lands on the next resolution) and passed to `resolve` as data; `touchSoftIdentity` upsert (first_seen fixed, last_seen moves).

**Tests:** 10 new (apps/core 36; workspace 257) — the Accept's three fast-check suites verbatim: (1) any input containing an active member match resolves T1 regardless of what else is present (500 runs, match injected into every slot); (2) the SAME input with members flipped to revoked downgrades to T2/T3 immediately (500 runs); (3) referential transparency — 1000 runs per sampled input, exactly one distinct output. Plus link-beats-hash head-to-head, no-context → t3-acquisition, the exhaustive frozen segment mapping, and store+resolve composition against Postgres (T1 via all three signals; DB-revoked row → non-T1 on next read; t2-new → t2-returning across sightings; unknown → T3). Build/lint exit 0.

**Deviation/notes:** fast-check v4 removed `hexaString` — replaced with `stringMatching` (caught by tsc). Store timestamps keep millisecond precision (a first/repeat sighting can share a second; resolve compares exact equality). The `clock` parameter is part of the stage signature per §4 but unused by Phase-0 rules (link expiry arrives with B23) — kept for signature stability.

---

## CORE-7 — Decisioning Slot + Guardrails stubs · ✅ 2026-07-04

**Built:** contracts-first `packages/contracts/src/pipeline.ts` (additive; M1-frozen trio shapes untouched): `EligibleOffer` (offer + nullable COR ref), `RankedOffer` (optional decisioner-internal `score`), `EligibilityExclusionReason`/`EligibilityExclusion`/`EligibilityResult` (SYN-37: §3 codes plus read-path-only `OFFER_NOT_LIVE` and `STACKING_DEDUPED`; the verify enum stays closed), `DecisionCtx`/`GuardrailCtx`, and the §5.5-verbatim `Decisioner` + `Guardrails` interfaces. `modules/decisioning/`: `PassthroughDecisioner` (stable offer_id sort — the Ph0 production decisioner) and `RandomDecisioner` (mulberry32 seeded PRNG, test-only). `modules/guardrails/`: `NoopGuardrails` (identity pass, empty suppressed). B7/B8 land later as file swaps behind these interfaces (P4).

**Tests:** 4 new — the staged Accept: swapping Passthrough↔Random preserves membership and the response SHAPE fingerprint byte-for-byte (score excluded as optional colour; every entry parses against `RankedOffer`) while the ranking actually differs; Passthrough stable/deterministic regardless of input order; RandomDecisioner deterministic per seed, different across seeds; Noop passes all, suppresses none. This test becomes B7's Phase-1 gate when RulesDecisioner lands.

**Decision (SYN-37, appended to plan §3 in this commit):** eligibility exclusion labels — §3 codes where they fit, `OFFER_NOT_LIVE`/`STACKING_DEDUPED` as read-path-only literals.

---

## CORE-6 — Eligibility, Phase 0 minimal · ✅ 2026-07-04

**Built:** `modules/eligibility/filter.ts` — PURE `filterEligibility(candidates, {tier, now, commitmentStatuses})` with §5.4's FIXED order: (1) offer liveness (status + injected-clock window) → `OFFER_NOT_LIVE` (SYN-37); (2) tier → `TIER_INELIGIBLE`; (3) commitment liveness + cap from the trio's SYN-7 status reads, passed in as data — non-live → `COMMITMENT_ENDED`, cap reached → `CAP_EXHAUSTED`, and an UNKNOWN status excludes conservatively (an unverifiable promise is never shown); walletless/non-bounty offers (`commitment_id: null`) skip stage 3; (4) stacking-group dedupe among survivors, winner = lowest `offer_id` (Ph1's stacking rules replace the policy inside the same step). First failure wins per offer. `fetchCommitmentStatuses` batches one trio read per DISTINCT COR (CORE-11 wires the HTTP client). Returns the contracts `EligibilityResult`.

**Tests:** 6 new (apps/core 46; workspace 267) — the Accept verbatim: the 8-offer fixture set covering all four outcomes, frozen clock, three runs, **canonical-JSON byte-compare identical**; exact per-offer outcomes asserted (2 eligible, 6 exclusions with their reasons in filter order); first-failure-wins (paused + tier-ineligible → `OFFER_NOT_LIVE`); unknown-COR conservative exclusion; tier flip re-admits the T1-only offer; batching dedupes CORs and drops nulls. Build/lint exit 0.

**Deviation/notes:** the Accept's "simulator seeded to a fixed state" is realised as a fixed status map injected as data — the pure function never does IO, so the trio simulator round-trip is exercised where the wiring lives (CORE-11's pipeline test and CORE-14's e2e), keeping this suite hermetic and byte-stable.
