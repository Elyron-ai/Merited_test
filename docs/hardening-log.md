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

---

## W2 — Consumer-scope every wallet mutation (IDOR sweep) · ✅ 2026-07-06 (findings #1, #10/#14, #24 + callback gap)

**Issue:** several wallet mutation routes acted on a caller-supplied object id with no ownership
predicate, so any authenticated consumer who learned another consumer's id (all non-secret ULIDs
that circulate in tokens, ledger events, `/v1/links` responses) could act on it:
- **#1 (high)** `POST /v1/mandates/:id/revoke` → `MandateService.revoke` UPDATE was `WHERE mandate_id = $1
  AND status='active'` — cross-consumer revoke, instantly stripping the victim's agent of checkout
  authority.
- **#10/#14 (medium)** `POST /v1/links/:id/revoke` → `LinkService.revoke` UPDATE was `WHERE link_id = $1
  AND status='active'` — cross-consumer unlink that ALSO revokes the victim's IdP refresh token and
  writes a false `AccountUnlinked`.
- **#24 (low)** `POST /v1/quotes/:id/decline` → `ApprovalsService.decline` wrote `ApprovalDeclined` for a
  caller-supplied quote with no ownership check, and its idempotency guard was global on `quote_id`,
  so an attacker could poison a victim's quote and short-circuit the owner's later decline.
- **OAuth callback (critic gap)** `LinkService.callback` enforced the session↔attempt binding only
  `if (sessionConsumerRef)` — a latent footgun (the route is session-gated today, so not live).

**Fix (one shared pattern):** thread `req.consumerRef` from each route and scope the write:
`AND consumer_ref = $2` on the mandate-revoke and link-revoke UPDATEs (returning false on no match —
idempotent, no oracle); in `decline`, resolve the quote and require `quote.consumer_ref === consumerRef`
before any ledger write (so only the owning consumer can ever write for a globally-unique quote_id —
the global idempotency guard is then safe as-is); make `callback`'s `sessionConsumerRef` **required**
and unconditionally matched. This mirrors the ownership checks already in `MandateService.attenuate`
and `approveExplicitForQuote`. **PD store verified already tenant-scoped** (`WHERE consumer_ref = $1`
on every `list/read/put/remove`) — that critic gap is refuted, no change.

**Tests (3 new negatives + regressions):** mandate revoke — a second consumer cannot revoke the
victim's mandate (returns false, mandate stays `active`), the owner still can (mandates suite 8→10);
link revoke — a second HTTP session cannot unlink the first's link (false, link stays `active`,
sealed tokens survive), the owner still can (linking suite 5→6); decline — a non-owner cannot decline
the victim's quote (false, no `ApprovalDeclined` written), the owner still can (approvals e2e 8→9).
The valet `wallet-approval.e2e` §6.1 mid-session-revocation path (real route, owner session) stays
green. Full workspace: build + lint clean, wallet 84→87, all suites pass.

**Security self-review (consent/linking-path — high-scrutiny):**
- *Authority verified before trust?* Yes — every destructive wallet mutation now requires the row to
  belong to the session consumer; a mismatch is a no-op (`false`), not an error, matching the existing
  idempotent-revoke contract and avoiding an existence oracle.
- *Inputs validated?* The scoping predicate uses the server-side session `consumer_ref`, never a
  client-supplied identity; ids remain the only caller input.
- *Destructive side-effects gated?* Yes — the IdP refresh-token revoke and `AccountUnlinked` in
  link-revoke, and the `ApprovalDeclined` ledger write in decline, now only fire for the owner.
- *No new oracle / no regression?* Uniform `false` on mismatch or missing; legitimate owner flows and
  the valet e2e revocation path unchanged.
- *Idempotency/replay?* Unchanged — revokes stay idempotent (`status='active'` guard); decline's
  once-per-quote guard is now unreachable cross-tenant.

**Convention note:** extended the XC-11 plan-sweep commit-id allow-list to recognise the `HARDEN-Wn`
prefix and documented it in `CONTRIBUTING.md` (post-build remediation is a distinct work category, not
a BUILD-PLAN task).
