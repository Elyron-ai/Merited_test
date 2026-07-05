# Launch-readiness register (living document)

Retained per the founder's instruction (2026-07-05). Three lists: **A** what
must be tested beyond CI, **B** third-party services to set up and the
credentials they need, **C** every gap not yet built, all phases. Maintained
by the build loop: when an item closes, mark it here in the same commit as
the work; new gaps found mid-build are appended, never silently dropped.
Owner column: **F** = founder (real-world action), **B** = builder (Claude
Code), **F+B** = both.

---

## A · Things to test (beyond what CI proves)

| # | Test | Owner | When | Status |
|---|---|---|---|---|
| A1 | Record `pnpm demo:act1` (human mode) as the Phase-0 demo asset | F | any time (gate 0 leftover) | ⬜ open |
| A2 | Timed key-rotation operational drill per `apps/trio/runbooks/key-rotation.md` §3 (routine < 15 min, compromise < 60 min), minuted for LEAD-5 | F+B | before real-money exposure (§9 Q12) | ⬜ open |
| A3 | Real-S3 smoke test of head publication (`S3ObjectStore` put/get/list + `verify-chain --against-heads s3://…`) | F+B | at go-live (needs B4 creds) | ⬜ open |
| A4 | Managed-Postgres PITR **restore drill**: restore into a scratch instance, run `verify-chain --against-heads` on the copy | F+B | once hosting exists (Q5) | ⬜ open |
| A5 | Web Push against a REAL browser push service (FCM/Mozilla autopush) — CI proves the encrypted request, not vendor delivery | B | Phase 2 (wallet UI, screen 5) | ⬜ open |
| A6 | Real email deliverability via Resend (SPF/DKIM/DMARC on the sending domain; magic links + hosted-linking codes land in real inboxes) | F+B | when B2 creds exist | ⬜ open |
| A7 | Stripe Connect TEST-MODE transfer end-to-end (the Phase-2 gate clause — a real transfer ID in evidence) | F+B | PH2-6, needs B1 creds | ⬜ open |
| A8 | Valet LLM interpreter with the flag OFF (real Anthropic API): NL briefs parse or fail closed to scripted path | F+B | PH2-5, needs B5 creds | ⬜ open |
| A9 | Load/rate-limit behaviour under production-shaped traffic (per-agent + per-merchant limits, Redis-backed limiter, replay-cache hit rates) | B | Phase 2 hardening | ⬜ open |
| A10 | Wallet UI cross-browser + accessibility pass (six screens; push permission prompts differ per browser) | B | PH2-3 | ⬜ open |
| A11 | `pnpm demo:act2` recorded with `VALET_DETERMINISTIC=1` (the Phase-2 gate asset) | F+B | PH2-12 | ⬜ open |
| A12 | Shopify dev-store end-to-end: install → cart-attribute token → `orders/paid` → verified claim | F+B | PH3-5, needs B7 creds | ⬜ open |
| A13 | Reference-verifier clean-container run: network egress disabled, proof pack only, tamper byte → fail | B | PH3-8/PH3-10 | ⬜ open |
| A14 | Control-plane e2e flake under full parallel load (Next boot + TOTP window — seen at the Gate-1 run, 12:25 table): confirm CI runner sizing or serialise those suites | B | before CI is authoritative for others | ⬜ open |

## B · Third-party services & credentials

Everything ships TODAY against stubs/fakes (typed env loader fails fast; a
real key is an env change, never a code change — the standing rule).

| # | Service | Purpose | Env vars / artefacts | Needed by | Status |
|---|---|---|---|---|---|
| B1 | **Stripe Connect** (platform account, test mode; KYB questionnaire; Express accounts recommended) | PH2-6 payouts; Phase-2 gate clause | `MERITED_STRIPE_SECRET_KEY`, `MERITED_STRIPE_WEBHOOK_SECRET` (names finalised at PH2-6 contracts-first PR) | **START NOW** — platform review takes weeks (LEAD-1 said mid-Phase-1) | ⬜ F to create; build proceeds on SimulatedPayouts |
| B2 | **Resend** (transactional email) | Magic links, hosted-linking codes, ops mail | `MERITED_RESEND_API_KEY`, `MERITED_RESEND_FROM` (+ domain DNS: SPF/DKIM) | Before any real consumer | ⬜ stubbed (Mailpit in dev) |
| B3 | **AWS KMS** (or GCP Cloud KMS — native Ed25519 is the SYN-32 upgrade path LEAD-5 ratifies) | Master key for envelope-encrypted signing keys + link-token/webhook-secret crypter | `MERITED_KMS_ENDPOINT`, `MERITED_KMS_KEY_ID`, AWS credentials | Hosting cutover | ⬜ fake-kms container in dev |
| B4 | **AWS S3** (public-read bucket for `heads/*`) | PH1-21 head publication — the external audit anchor | `MERITED_HEADS_BUCKET`, `MERITED_HEADS_ENDPOINT` (optional, MinIO), AWS credentials | Go-live (A3 smoke) | ⬜ FakeObjectStore in dev/CI |
| B5 | **Anthropic API** | PH2-5 Valet LLM brief-interpreter (optional; `VALET_DETERMINISTIC=1` fallback is mandatory for recording) | `ANTHROPIC_API_KEY` | PH2-5 flag-off testing (A8) | ⬜ not needed for gate |
| B6 | **Hosting** (Fly.io/Render vs AWS — §9 Q5, forced by partner security review before any real cutover) + managed Postgres (PITR) + managed Redis | Production runtime | Provider account, DB/Redis URLs, TLS/domain | Before PH2-6 live-mode and any partner | ⬜ undecided (Q5) |
| B7 | **Shopify Partner account + dev store** (+ app review, protected-customer-data access) | LEAD-3 → PH3-5 Grade-A app | Partner org, dev store, app API key/secret | Start of Phase 2 (review runs concurrently) | ⬜ F to create |
| B8 | **Observability sink** (Axiom or Grafana Cloud per §2.2) | OTel traces + `mint_vs_claim_under_reporting` alerts + head-publication failure alerts | OTLP endpoint + token env | Before partner traffic | ⬜ memory/console exporters in dev |
| B9 | **VAPID keypair** (self-generated — no vendor) | Web Push identity | `MERITED_VAPID_PUBLIC_KEY`, `MERITED_VAPID_PRIVATE_KEY`, `MERITED_VAPID_SUBJECT` | Production wallet | ⬜ ephemeral dev keys; generate + pin for prod |
| B10 | **Partner IdP registration** (Auth0/Cognito/native — when a real programme partner exists) | Account linking beyond FakeAurora | Client id/secret per programme into the IdP registry | Partner onboarding (Q3 also applies) | ⬜ FakeAurora stands in (SYN-33) |
| B11 | **Payments lawyer** (LEAD-2, PSR/EMI perimeter) & **security auditor** (LEAD-5, 2–5 days) | Legal posture; SYN-32 review substitute | Engagement letters; outcomes filed in `docs/decisions/` / findings tracked | LEAD-2 before live transfers; LEAD-5 before real money/production exposure | ⬜ F to book (both in §9 Q8/Q12) |
| B12 | **Trademark screen** (UK IPO/USPTO) for the Valet name | Before investor materials (Q6) | — | Before Act-2 recording circulates | ⬜ F |

## C · Gaps — everything not yet built, all phases

### C0 · Phase-1 leftovers (build FIRST — §0.1)

| Item | What | Size | Status |
|---|---|---|---|
| **TRIO-17** | Live directory wiring: replace the fixture `TrioDirectory` with the HTTP client hitting wallet approval/mandate lookup endpoints (attestations still verified before trust). Wallet needs the lookup endpoints; trio needs the client. Needed by the Phase-2 gate mapping (Act-2 negatives). | S | ✅ done 2026-07-05 |
| **XC-13** | Phase-1 hardening review pack `docs/reviews/ph1-hardening.md` (feeds LEAD-5): token-storage checklist, lint-rule evidence, rotation-runbook item, head-publication check, and the EXECUTED hosting decision (Q5 — founder). | S (doc) + Q5 (F) | 🚧 pack assembled 2026-07-05; awaits LEAD-5 sign-off + Q5 |
| **XC-11** | Weekly plan-state sweep 2 (Accept completes) | — | ⬜ due 2026-07-11 |
| Production wiring seams left deliberately open in Phase 1: send-on-quote push trigger (production caller of `PushService.sendQuoteNotification` — lands with PH2-4/PH2-11); points-credit production consumer ✅ closed by PH2-10 (2026-07-05); native-Ed25519 KMS upgrade (LEAD-5 ratifies). | — | — | tracked below |

### C1 · Phase 2 — Optimiser & scale (Q1 27)

| Task | What | Size | Status |
|---|---|---|---|
| PH2-1 | B8 guardrails full: margin floor, budget pacing λ, brand rules, points-preference under low λ; `BUDGET_EXHAUSTED` flips reads to `no_offer` visible in analytics within one cycle | L | ✅ done 2026-07-05 |
| PH2-2 | Merchant dashboard over B19 projections (under-reporting, rejections-with-why, budget burn, conversions) — no new data collection | M |✅ done 2026-07-05 |
| PH2-6 | Stripe Connect payouts behind `PayoutRail` + payout worker on `SettlementNetted`; same adapter contract test as SimulatedPayouts; env-loader guard refuses live keys until LEAD-2+LEAD-5 resolved | L |✅ done 2026-07-05 — code complete on stubbed keys; A7 (real test-mode transfer) waits on B1 |
| PH2-4 | Valet full: wallet-driven errands, mandate in ctx, AWAITING_APPROVAL live, notification/approval loop, re-minted `apr` token to checkout; kill/restart resumes | L | ✅ done 2026-07-05 |
| PH2-3 | Wallet UI — six screens (home/balances, linked accounts, mandate, offers-for-you, errand, activity&settlement); expect 2–3 slices | L | ✅ done 2026-07-05 — all six screens; Act-2 steps performable on-screen (A10 a11y sweep stays open) |
| PH2-5 | Valet LLM brief-interpreter + `VALET_DETERMINISTIC=1` scripted fallback | M |✅ done 2026-07-05 — LLM path on stubbed key (B5); flag-off live smoke = A8 |
| PH2-9 | 1pd enrichment: consented pd → `DecisionCtx` iff `mandate.data_sharing` permits; revocation strips on next read; never in agent-facing responses (lint+test) | M | ⬜ |
| PH2-10 | Loyalty points-credit flow on wallet-path `ConversionVerified` (idempotent per claim; walletless credits nothing) | M |✅ done 2026-07-05 (screen rendering = PH2-3) |
| PH2-8 | Feature assembly + training pipeline (`apps/ml-decisioner/training/`, Python; ledger exhaust only; LEAD-4 synthetic traffic if thin) | M | ⬜ |
| PH2-7 | ML sidecar via `Decisioner` HTTP impl + timeout fallback; CI decisioner-swap job diffs schemas (must be empty) | L | ⬜ |
| PH2-11 | Demo Act 2 — all 9 §10 steps incl. both negative cases on camera; one trace brief→ledger | L | ⬜ |
| PH2-12 | Phase-2 gate run + recording; evidence in `docs/gates/phase-2.md` | S | ⬜ |

### C2 · Phase 3 — Interop & exit-ready (Q2 27) — all ⬜

| Task | What | Size |
|---|---|---|
| PH3-1 | JSON-LD offer feed (anonymous = untokenised + register_to_earn; registered = tokenised via canonical path) | M |
| PH3-2 | Protocol conformance harness + UCP/ACP token-transport mapping (resolve arch §8 Q2 first; Zod schemas contracts-first) | M |
| PH3-3 | UCP ProtocolAdapter (offer-out + callback-in → signed claim; Valet UCP rail) | L |
| PH3-4 | ACP ProtocolAdapter (same shape; Valet ACP rail) | L |
| PH3-5 | Shopify app Grade A (cart-attribute token, orders/paid, CommerceAdapter parity with FakeShop) | L |
| PH3-6 | Self-serve merchant onboarding, zero manual steps end-to-end | L |
| PH3-7 | Open third-party verification spec (`docs/spec/verification.md`) — can be drafted during Phase-2 downtime | M |
| PH3-8 | Reference verifier (`packages/verifier/`, offline, clean-container proof) | L |
| PH3-9 | SKU-level offer granularity end-to-end (eligibility, quoting, JSON-LD, Shopify mapping, bundle sku_refs) | M |
| PH3-10 | Phase-3 gate run; evidence in `docs/gates/phase-3.md` | S |

### C3 · Founder/external items (LEAD + open questions)

| Item | What | Needed by |
|---|---|---|
| LEAD-1 | Stripe Connect platform account (see B1) | overdue vs plan (mid Phase 1) — start now |
| LEAD-2 | Payments-lawyer session; outcome in `docs/decisions/` | before any live-mode transfer |
| LEAD-3 | Shopify partner account + dev store + app review (see B7) | start of Phase 2 |
| LEAD-4 | ML training-data adequacy check; synthetic-traffic generator in `tools/seed/traffic/` if exhaust thin (builder part) | end of Phase 1 → check at PH2-8 start |
| LEAD-5 | External security audit (see B11); findings to close | before real money / production exposure |
| Q4 | Clawback-window economics default | before real commercial config |
| Q5 | Hosting decision (+ PITR + RLS carried on the cutover checklist) | before PH2-6 live-mode / partner review |
| Q6 | Valet naming clearance | before recorded demo circulates |
| Q7 | Pre-authorisation default threshold (Act 2 fixes £50 for the demo) | Phase-2 detailed planning |
| Q10 | Shopify distribution model (public vs custom-app) | end of Phase 2 |
| Q11 | Conversion proof-pack composition | Phase 3 (earlier if UIP moves) |
| Q12 | Gate-1 manual items (LEAD-5 booking + rotation drill minute) | before real-money exposure |

### C4 · Explicitly out of scope unless forced (§11 / gate-path notes)

Salesforce Commerce Cloud adapter (interface parity only) · loyalty
aggregation across programmes · native mobile · real consumer payment auth ·
Eagle Eye AIR wiring (only if a real programme partner exists — off the gate
path).
