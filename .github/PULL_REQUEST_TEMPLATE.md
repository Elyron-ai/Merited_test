<!-- Title format: feat(TASK-ID): summary -->

## Task-ID (mandatory)

<!-- The BUILD-PLAN.md row this PR delivers, e.g. CORE-10. Every PR carries
     exactly one; the ID appears in the PR title too. -->

TASK-ID:

## What & why

<!-- One or two sentences. The task row's Accept clause is the definition of
     done — say how this PR meets it. -->

## Contracts

- [ ] **Touches contracts first?** — if this change needs a new or altered
      shared type, the `packages/contracts` change is in this PR's first
      commit (or already landed). If no shared type changes: tick and move on.

## Checks

- [ ] `pnpm -r build && pnpm -r test && pnpm lint` green locally
- [ ] `BUILD-PLAN.md` task state updated + `docs/build-log.md` entry appended in this PR
- [ ] No secrets, no floats near money, UK English in copy
