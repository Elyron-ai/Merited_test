# Merited — build session rules

You are building the Merited platform. Three documents are canon, in this order of authority:

1. `BUILD-SPEC.md` — the build brief. When anything conflicts with it, the spec wins.
2. `BUILD-PLAN.md` — the execution plan (v1.1, solo build). Its §3 synthesis register (SYN-1…33) is binding; its task IDs are the unit of work.
3. `merited-platform-architecture.md` — design rationale. Where both are silent, its §0 principles P1–P5 decide.

## How work proceeds

- Work is executed task-by-task from `BUILD-PLAN.md`, in §4.2 calendar order / dependency order. Use the `/build-next` command for each iteration.
- A task is **done** when its Accept clause is green in CI-equivalent local runs — not when the code merges. The Accept clause is the definition of done; never weaken, skip, or delete a failing Accept test to make progress. If a test seems wrong, stop and record the conflict in `docs/build-log.md` instead.
- Update the task's state in `BUILD-PLAN.md` (append `— ✅ done <date>`, `— 🚧 doing`, or `— ⛔ blocked: <reason>` to the task's row) in the same commit as the work.
- Commit per task: `feat(TASK-ID): summary` (XC.9). Never commit secrets. Push after each green task.
- Append one entry per task to `docs/build-log.md`: what was built, test results, any deviation from the plan, any decision taken.
- `docs/launch-readiness.md` is the living register of untested items, third-party services/credentials, and unbuilt gaps across all phases. When a task closes one of its items, tick it there in the same commit; newly discovered gaps are appended, never silently dropped.

## Hard guardrails

- **Phase order (§0.1, §9):** never start a later-phase task while the current phase's gate is unmet. Gate checklists are in BUILD-PLAN §8 (XC.5).
- **No real cryptography in Phase 0** (SYN-32): Phase 0 uses `FakeSigner`/`FakeCrypter` and pseudo-tokens only. Real PASETO/Ed25519/KMS work is Phase 1 (PH1-24…26/30), file-for-file behind the unchanged contract suite. Library-only crypto, always — never hand-rolled primitives.
- **Zero-edit rule:** once the trio contract suite is frozen (M1/XC-7), any edit to it during the real-implementation tasks is a red flag — stop, log it in `docs/build-log.md`, and treat it as a contract bug per XC-7 change control.
- **Contracts-first (§1):** every shared type lives only in `packages/contracts`; a contract change lands there first.
- **High-scrutiny zones (BUILD-PLAN §8 XC.7):** trio, signing, token-client, adapter claim-signing, ledger DDL, linking token store. For any PR-sized change in these paths, add a `Security self-review` section to the build-log entry (inputs validated? signatures verified before trust? secrets/keys never logged? replay/idempotency considered?).
- UK English in all copy. Money is integer pence (`GBP_pence`) — never floats. Redis is never a source of truth. Webhook signature verification on even in dev.

## Decisions

- Pre-answered: Q1 — build the 27-mechanics union exactly as FND D10's table (SYN-28). Q2 — the calendar is indicative; dependency order is what matters.
- A genuinely new decision (spec + plan + principles all silent) gets a new SYN-row appended to BUILD-PLAN §3 in the same commit, not a silent choice.
- A question only the founder can answer: add it to BUILD-PLAN §9's table, mark the task ⛔ blocked, move to the next unblocked task.

## Environment

- Node 22 (`.nvmrc` once FND-1 lands), pnpm via corepack, Docker Desktop running.
- First run / after reboot: `docker compose up -d --wait` (once FND-2 exists), `pnpm i`, `pnpm db:migrate`.
- Before declaring any task done: `pnpm -r build && pnpm -r test && pnpm lint` (or the closest available subset until FND-16 lands).
