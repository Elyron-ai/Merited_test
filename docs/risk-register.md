# Risk register (XC-10)

Living document, seeded from BUILD-PLAN §8 XC.6. Likelihood/Impact: L/M/H.
Owners: **Builder** (solo, with Claude Code) · **Auditor** (LEAD-5 external
reviewer) · **Founder** (commercial/programme owner).

**Review ritual:** fortnightly, date-stamped in the log below. Each sitting
walks every open risk: has likelihood/impact moved, did a trigger fire, is
the mitigation still real (not aspirational)? New risks get the next R-number;
closed risks move to the closed section with the closing evidence. The
competitive watch (R9) is explicitly on the agenda quarterly.

**Next review: 2026-07-17** (then fortnightly).

## Open risks

| # | Risk | L | I | Mitigation | Owner | Phase 0 posture (2026-07-04) |
|---|---|---|---|---|---|---|
| R1 | Merchant under-reporting — tokens minted, claims never filed (arch §5) | H | H | Mint-vs-claim monitor per merchant at Phase 1 (B19, Gate 1 item); contractual audit rights; Phase 3 third-party verification makes non-reporting detectable | Founder + Builder (B19) | Rehearsable now via `FAKESHOP_DROP_WEBHOOK_PCT`; threat noted in `docs/trio-threat-notes.md` §4; monitor lands Phase 1 |
| R2 | A future partner rejects custodied merchant keys (arch §8 Q3) | M | M | Deferred until a partner exists (SYN-33); API already assumes merchant-held keys so handover pulls forward without contract changes; raise in any partner security review | Founder | Handover path documented (`trio-threat-notes.md` §5); versioned key refs required of PH1-30 |
| R3 | Security-critical code built without independent expert review (SYN-32) | M | H | Library-only crypto; unchanged contract suite + property tests as the objective gate (XC-12, zero-edit); high-scrutiny checklists per zone PR (XC-3, enforced in CI); TRIO-16 audit pack; LEAD-5 audit before real money; trio isolation (P3) | Builder (controls), Founder (LEAD-5 commissioning) | All Phase-0 controls live: zones enforced, pack written, suite frozen 43/43 (one PH1-2 change-controlled extension, minuted); LEAD-5 commissioning is a Gate 1 item |
| R4 | Contract churn after freeze breaks trio work in flight | M | H | XC-7 change control (contracts-first PR + suite update same PR + recorded review + version bump); churn budget reviewed fortnightly here; union extension points absorb most additions | Builder | Freeze active since M1 (ADR-009); zero post-freeze wire-shape changes to date |
| R5 | Demo nondeterminism ruins the recorded asset or flakes CI | M | M | Fixed fixtures + seeded IDs (XC-5 kit for new fixtures); demo-as-E2E on every merge with load-bearing asserts (XC-8); `VALET_DETERMINISTIC=1` for Act 2 (§6.6); clean-machine job in CI | Builder | Act 1 byte-stable in CI (`gate:0` green end-to-end); Act 2 controls land Phase 2 |
| R6 | Valet naming clearance fails (arch §8 Q6) | M | M | UK IPO/USPTO screen before any investor material; name isolated in code (constants + centralised copy) so a rename is a day | Founder | Screen not yet run — open founder action |
| R7 | PSR/EMI perimeter triggered before real money moves (arch §2.5, §8 Q4) | L | H | Phase 1 payouts are statements only; one-hour payments-lawyer session gates any Phase 2 Stripe Connect work; Connect keeps Merited outside money transmission | Founder | Phase 0 moves no money by construction; env-loader guard on live keys specified for PH2-6 |
| R8 | OAuth token-storage weakness leaks refresh tokens | L | H | B23 design: encrypted at rest via `Crypter`/KMS data key, separate table, never in contracts; mandatory review before Gate 1 (XC-13); leak lint + test in CI | Auditor (review), Builder (impl) | FND-15 lint live (bans token keys in contracts + logger args repo-wide); storage itself is Phase 1 (PH1-8) |
| R9 | UIP/Talon.One adds conversion verification, eroding the moat (arch §8 Q5) | M | M | Quarterly competitive watch logged HERE; trigger: any verification field in their protocol pulls the Phase 3 open-verification spec forward to Phase 1 | Founder | First watch due at the 2026-10 sitting; no trigger observed |
| R10 | Single-builder bus factor / velocity stall | M | M | Everything reproducible from repo (clean-machine rule, proven in CI); BUILD-PLAN task states current (XC-11 sweep); contracts-as-single-source onboardable | Founder | `git clone` → `pnpm demo:act1` proven on a bare checkout every merge |
| R11 | Vendor drift between fakes and real integrations (Shopify, Eagle Eye) found late at wire-up | M | M | §2.2 adapter interfaces reviewed against CURRENT vendor docs when each adapter is defined, not wired; wire-up milestones carry slack; fakes stay as CI substrates forever | Builder | Port interfaces typed (FND-6); review-at-definition noted on each PH row |
| R12 | Quotes read as reservations by partners; disputes at verification | L | M | §4 "priced promises, not reservations" reproduced in SDK docs and merchant agreement; `CAP_EXHAUSTED`/`BUDGET_EXHAUSTED` surfaced to both sides from day one | Founder + Builder | Reason codes wired through claims viewer (MER-10) and SDK; agreement language is a founder action |

## Closed risks

None yet.

## Review log

| Date | Attendees | Notes |
|---|---|---|
| 2026-07-04 | Builder (seeding) | Register seeded from XC.6 at Phase 0 close-out; postures recorded above. First full sitting set for 2026-07-17. |
