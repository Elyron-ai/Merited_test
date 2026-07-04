# Merited build log

One entry per task, newest last. Format: task, what was built, test results, deviations, decisions.

---

## FND-1 — Monorepo scaffold & toolchain · ✅ 2026-07-04

**Built:** pnpm workspace with all 13 §1 members (packages/{contracts,events,signing,sdk}, apps/{core,trio,control-plane,wallet,valet,mcp-server,fake-aurora}, tools/{seed,demo}), each with ESM package.json (@merited/* scope), composite tsconfig wired into a root `tsc -b` project-reference graph, and placeholder src/index.ts. Root: package.json (scripts: build/test/lint/typecheck/db:migrate/verify-chain/projections:rebuild, packageManager pnpm@10.33.0, engines node>=22), pnpm-workspace.yaml with a version catalog (typescript/vitest/@types/node), tsconfig.base.json (strict, NodeNext, composite, verbatimModuleSyntax), eslint.config.js (ESLint 9 flat + typescript-eslint recommended), .prettierrc, vitest.workspace.ts, .nvmrc (22), .editorconfig. One smoke test in contracts proves the vitest wiring. No Turborepo (FND D5/SYN-17).

**Tests:** `pnpm i && pnpm -r build && pnpm -r test && pnpm lint` all green on this machine (Node 22.22.2, pnpm 10.33.0). Contracts smoke test: 1 passed. `tsc -b` resolves the cross-package graph (events/signing/sdk/apps → contracts).

**Deviations:** none. `packages/otel` deliberately not scaffolded — it arrives with FND-14 (SYN-2).

**Notes for later tasks:** apps/control-plane and apps/wallet are plain-TS placeholders; MER-7/PH1-9 replace their scripts with Next.js 15 when they land. pnpm build-script approvals (esbuild etc.) not needed yet — revisit if a dep requires postinstall.
