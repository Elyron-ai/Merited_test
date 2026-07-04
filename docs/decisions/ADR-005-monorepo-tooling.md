# ADR-005 — Monorepo tooling: pnpm workspaces only

**Status:** accepted (week 1; XC.8 D5, SYN-17)

## Context

The repo scaffold (FND-1) hard-codes the workspace tooling; changing it
later touches every package. Turborepo/Nx add caching and task graphs at
the cost of configuration surface and a second scheduler to reason about.

## Decision

pnpm workspaces only — no Turborepo, no Nx in Phase 0 (SYN-17, FND D5 over
XC D5's initial suggestion). `pnpm -r build` orders by workspace topology;
`tsc -b` project references handle incremental compile; Vitest runs
per-package. Corepack pins pnpm; the catalogue (`pnpm-workspace.yaml`
`catalog:`) pins shared dependency versions.

## Consequences

- One scheduler (pnpm's), one lockfile, no cache-invalidation mysteries in
  CI.
- Revisit ONLY if CI times hurt — the recorded trigger, so the question is
  data-driven rather than fashion-driven.

**Implemented in:** `pnpm-workspace.yaml`, root `package.json` scripts,
`.github/workflows/ci.yml`.
