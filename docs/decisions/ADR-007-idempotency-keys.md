# ADR-007 — Idempotency-Key semantics

**Status:** accepted (week 1, design-before-build; XC.8 D7 — landed with
MER-3/4 and TRIO-8)

## Context

Webhook deliveries retry; claim submissions retry; the §8 requirement is
that a retried request cannot double-apply. The semantics had to be fixed
before the adapter intake (MER-3/4, week 6) was built against them.

## Decision

A Postgres table keyed `(scope, key)` storing a hash of the request and a
snapshot of the response:

- Replay with the SAME key and SAME body → the stored response, returned
  **byte-for-byte** (the snapshot is canonical JSON, not a re-computation).
- Same key, DIFFERENT body → `422 IDEMPOTENCY_CONFLICT` — a key is a claim
  about content, not just a deduplication token.
- The key row is written in the SAME transaction as the side effects it
  guards (verdict, ledger events, counters) — there is no window where the
  work happened but the key is unrecorded.
- Retention: TTL ≥ the clawback window, so a replay can never outlive the
  facts it must agree with.

## Consequences

- Duplicate webhook delivery produces one claim and one verdict (proven in
  MER-12 and the trio contract suite).
- Idempotency storage is Postgres — never Redis (§0: Redis is never a
  source of truth).

**Implemented in:** `trio.idempotency_keys` (+ core's `core.idempotency_keys`
for the adapter funnel), enforced in `verify-pipeline.ts` and MER-3/4.
