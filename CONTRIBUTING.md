# Contributing to Merited

Canon, in order of authority: `BUILD-SPEC.md` → `BUILD-PLAN.md` →
`merited-platform-architecture.md`. Where they are silent, architecture §0's
principles P1–P5 decide. Per-task history lives in `docs/build-log.md`.

## The contracts-first rule

BUILD-SPEC §1, verbatim:

> Rule: **`packages/contracts` is the only place types are defined.** Core, trio, wallet, SDK, and tests all import from it. A contract change is a PR that touches `contracts` first.

In practice: no Zod schema or shared type is declared under `apps/*` or any
other package; if a change needs a new or altered shared shape, the
`packages/contracts` commit lands first and everything else follows it. The
PR template asks you to confirm this on every PR.

## Branches, commits, PRs

- **Branch naming:** `feat/<TASK-ID>-slug` — e.g. `feat/CORE-10-quote-persistence`.
  The task ID is a `BUILD-PLAN.md` row; task IDs are immutable and never
  renumbered.
- **Commits:** `feat(TASK-ID): summary` (XC.9). One task per commit. Never
  commit secrets. Post-build security/accessibility remediation uses the
  `HARDEN-Wn` id (e.g. `fix(HARDEN-W2): …`), logged in `docs/hardening-log.md`.
- **PRs:** the template's Task-ID field is mandatory, as is the
  "touches contracts first?" answer. A task is **done** when its Accept
  clause is green in CI-equivalent local runs — not when the code merges.
- Update the task's state in `BUILD-PLAN.md` and append the
  `docs/build-log.md` entry in the same commit as the work.

## House rules

- **UK English** in all copy — user-facing strings, error messages, docs.
- **Money is integer pence** (`GBP_pence`) and rates are integer basis
  points — floats never touch a monetary value, on the wire, in the
  database, or in a form parser. CI lints for this.
- **Redis is never a source of truth.** Postgres rows and the hash-chained
  ledger are.
- **Webhook signature verification stays on in every environment**, dev
  included.
- **No real cryptography in Phase 0** (SYN-32): `FakeSigner`/`FakeCrypter`
  and pseudo-tokens only. When real crypto lands (Phase 1), it is
  library-only — never hand-rolled primitives.
- **High-scrutiny zones** (BUILD-PLAN §8 XC.7: trio, signing, token-client,
  adapter claim-signing, ledger DDL, linking token store): any PR touching
  them carries a security self-review — inputs validated? signatures
  verified before trust? secrets/keys never logged? replay/idempotency
  considered?
- **The frozen trio contract suite** (`apps/trio/contract-tests/`, XC-7):
  editing it is a red flag — stop and treat it as a contract bug, never a
  test to fix.

## Plan maintenance (XC-11)

`BUILD-PLAN.md` is a living document and the single source of task state:

- **States live in the task's row**: `— ✅ done <date>` · `— 🚧 doing` ·
  `— ⛔ blocked: <reason>`; no marker means todo. The state changes in the
  SAME commit as the work it describes — never in a separate tidy-up.
- **Task IDs are immutable** and appear in every PR title and commit
  subject (`feat(TASK-ID): …`). Superseded tasks are struck through, never
  renumbered; new tasks append to their workstream table (synthesis
  decisions append to §3 as new SYN rows).
- **Weekly status sweep**: every marker re-checked against reality, logged
  in `docs/build-log.md` as `Plan sweep — <date>`. A CI test keeps ✅ rows
  and build-log entries in lockstep between sweeps.

## The verify loop

```sh
pnpm -r build && pnpm -r test && pnpm lint
```

All three green before a task is declared done. First run / after reboot:
`docker compose up -d --wait`, `pnpm i`, `pnpm db:migrate`. The demo
(`pnpm demo:act1`) and the trio contract suite (`pnpm trio:contract-test`)
are the deeper checks when your change is anywhere near their paths.
