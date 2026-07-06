# Hardening log — post-build security & accessibility remediation

Source: the read-only security + accessibility audit (2026-07-06) and the plan it produced.
Each entry is one fix: what the issue was, the change, the tests, and — for security-zone
changes — a Security self-review (CLAUDE.md XC.7). This work is remediation on the completed
build; it is NOT a BUILD-PLAN phase task, so it is logged here rather than in `docs/build-log.md`,
and it does not touch the frozen trio contract suite.

---

## W1 — Lock down the sessionless `/v1/approval-requests` surface · ✅ 2026-07-06 (findings #5, #32)

**Issue (#5, high):** `ApprovalRequestsService.create` accepted any `quote_id` + any `mandate_id`
with no binding between them. An *unauthenticated* caller (the route is a session carve-out at
`server.ts:152`) who learned a quote_id and a mandate_id — both non-secret ULIDs that circulate in
mint requests / `merited:quote_id` envelopes / logs — could force an implicit approval against a
**different consumer's** mandate (when the quote value sat at/below that mandate's
`pre_authorised_up_to`) and receive the re-minted `apr`-bearing convertible token in the response.
Cross-consumer authority use + bearer-token disclosure with zero authentication.

**Fix:** `apps/wallet/src/modules/notifications/approval-requests.ts` — after resolving the quote
and mandate, bind them before *any* approval or persistence:
`quote.agent_id === mandate.agent_id` (mandatory) and `quote.consumer_ref === mandate.consumer_ref`
(when the quote carries a consumer_ref). A mismatch returns `null` → a uniform 404, so there is no
cross-tenant existence oracle and no `approval_requests` row, `Approval`, or token is created for a
mismatched pair. This mirrors the ownership checks already enforced in `MandateService.attenuate`
and `approveExplicitForQuote`.

**Tests:** new `approval-requests.integration.test.ts` (3) — a correctly-bound pair still approves
implicitly and returns the token (regression); a quote for a **different agent** → `null`, no
approval row, no `Approval`, no minted token; a quote bound to a **different consumer** → same. The
existing `approvals.e2e.test.ts` (8) and the valet `wallet-approval.e2e.test.ts` (6, which drives
the real `POST /v1/approval-requests` implicit path through `WalletApprovalGate`) stay green.
Full workspace: build + lint clean, 929 tests pass (wallet 81→84).

**Security self-review (consent-path / token-path — high-scrutiny):**
- *Inputs validated?* Yes — the binding runs on server-resolved records (the quote from
  `core.quotes`, the mandate from `wallet.mandates`), not on caller-supplied identity; the caller
  still supplies only the two ids.
- *Authority verified before trust?* Yes — an approval/re-mint now requires the mandate to own the
  quote's agent (and consumer). The trio's live re-verification (mandate status, quote expiry,
  per-txn/per-month limits) and its attribution of bounty to `minted.aid` (not the presenter) remain
  the downstream backstops.
- *Secrets/tokens never over-disclosed?* The token is no longer mintable against an unrelated
  consumer's mandate. It is still returned on the sessionless poll for a resolved approval (required
  by the explicit-approval flow, where the token is minted only after the consumer decides) — see
  residual.
- *No oracle?* Mismatches return the same 404 as a genuinely missing quote/mandate.
- *Replay/idempotency?* Unchanged — per-quote idempotency (`UNIQUE(quote_id)`, `aprq/${quoteId}` key)
  and the trio's `consumed_jtis` single-use per qid still hold.

**Residual (tracked, not silently dropped):** #32 (low) is *narrowed but not fully closed*. An
attacker who holds **both** a victim's quote_id and its matching mandate_id (the victim's own bound
pair) can still trigger the implicit approval and read the token from the sessionless GET; and the
explicit-flow token is retrievable by anyone who knows a quote_id whose approval has resolved. Full
closure needs **agent-key authentication on the wallet route** so only the quote's owning agent can
create/pick up — a cross-service (wallet↔core) auth plumbing change beyond this focused fix, and
already recorded in `docs/build-log.md` as a LEAD-5 candidate ("binding pickup to the requesting
agent's API key"). Impact is bounded by the trio (single-use per qid, live limit re-checks, bounty
attributed to the minted agent, not the presenter). Carried as **W1-residual** for the auth-plumbing
follow-up.
