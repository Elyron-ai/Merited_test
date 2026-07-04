# Migrations policy (FND-9 / BUILD-PLAN D8, BUILD-SPEC §8)

- **Forward-only.** Never edit an applied migration — the checksum guard (`pnpm --filter @merited/events db:check`) fails the build if a recorded file changes. Fixing a mistake means a new migration.
- **Numbered SQL in each owning package** (`drizzle/` + `drizzle.config.ts`); drizzle-kit-generated where possible, hand-written SQL permitted for roles/REVOKE/triggers.
- **Two roles (D8):** `merited_migrate` runs DDL (the runner refuses any other role); `merited_app` is runtime-only — no DDL, and `REVOKE UPDATE, DELETE` on ledger tables (append-only enforced in Postgres, not just code — §8).
- **Orchestration:** root `pnpm db:migrate` runs every package's `db:migrate` in topological order, single-file concurrency (events first).
- **New migration checklist:** write the SQL → add a `_journal.json` entry → `db:check --update` to record its checksum → commit all three together.
