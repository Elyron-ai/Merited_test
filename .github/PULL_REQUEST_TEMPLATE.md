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

## Security self-review

<!-- MANDATORY when this PR touches a high-scrutiny zone (BUILD-PLAN §8,
     XC.7: contracts, signing, events/ledger DDL, trio, token-client,
     adapter claim-signing, wallet linking, mandate attestation). Zone PRs
     are auto-labelled `high-scrutiny` (the LEAD-5 audit trail is the query
     `is:pr label:high-scrutiny`) and CI fails the security-review check
     unless every box below is ticked. Not touching a zone? Tick them —
     they are true vacuously — or delete the section; CI only enforces it
     on zone diffs. -->

- [ ] Inputs validated at every new or changed boundary
- [ ] Signatures verified before trust — never after use
- [ ] Secrets and keys never logged, serialised or persisted in plaintext
- [ ] Replay/idempotency considered (and tested where behaviour changed)
