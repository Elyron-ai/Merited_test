# ADR-004 — Hosting choice: explicitly deferred

**Status:** deferred (week 1; XC.8 D4 — decision point: Phase 1 hardening)

## Context

Fly.io vs Render (vs AWS) is a real choice with real security-review
consequences — and zero Phase 0 relevance: Phase 0 is docker-compose local
plus a recorded demo, with no deploy work at all.

## Decision

Defer to Phase 1 hardening, per architecture §6 (AWS if a partner security
review demands it). Recording the deferral is the decision: it prevents
week-1 yak-shaving AND stops the question silently becoming urgent — the
Phase 1 hardening review (XC-13) carries it as an explicit agenda item
("execute deferred hosting decision (D-4)").

## Consequences

- Nothing in Phase 0 may assume a host: configuration stays env-var-driven
  (typed loader, §8), storage stays Postgres + object-file artefacts,
  nothing binds to a platform API.
- The trio's KMS custody model (SYN-32) names the capability, not the
  vendor; the hosting decision picks the vendor.

**Revisit:** Phase 1 hardening (XC-13 review pack; LEAD-5 in the loop).
