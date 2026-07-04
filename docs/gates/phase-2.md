# Gate 2 — Optimiser & scale (living checklist)

BUILD-PLAN §8 XC.5 / BUILD-SPEC §9.

- [ ] `pnpm demo:act2` end-to-end on real rails: link Aurora Club →
      mandate → brief Valet → push notification → approve → transact →
      Aurora Club points credited on the activity screen.
- [ ] Netting run produces a real Stripe Connect transfer in test mode
      (no live-mode key accepted while LEAD-2 or LEAD-5 is unresolved).
- [ ] Decisioner swap (`RulesDecisioner` → `RandomDecisioner`) requires
      zero API changes — proved in CI (ranking-only diff).
- [ ] Act 2 negative cases scripted: mid-errand mandate revocation →
      `MANDATE_REVOKED`; declined notification → errand `DECLINED`,
      nothing charged or settled.
