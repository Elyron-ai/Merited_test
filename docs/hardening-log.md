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

---

## W3 — Read/quote-path consumer-identity binding · ✅ VERIFY-ONLY 2026-07-06 (critic gap — no code change)

**Investigated (the full trace):** MCP `consumerFrom()` (`apps/mcp-server/src/tools.ts`) forwards caller-supplied
`consumer_ref`/`sub_hash`/`member_ref`/`hashed_email` → the SDK sends them as `GET /v1/offers` query params
(and `/v1/eligibility` body), agent-authenticated → the core route (`routes/v1/index.ts` `consumerFrom`)
builds `ConsumerCtx` from them verbatim, with NO agent↔consumer authorization → `resolve()`
(`identity/resolve.ts`) maps a matching ACTIVE member (by consumer_ref/sub_hash/member_ref) to **T1
member tier** + `identity_ref = member.member_ref`, independent of any mandate → the quote stage prices
T1 member pricing and mints a token bound to that identity. Separately, PH2-9 pd enrichment
(`PgPdReader.pdFor(mandateRef)`) gates on `mandate_id` + `status='active'` + `data_sharing`, but does
**not** check `mandate.agent_id === the reading agent`.

**Verdict — REFUTED as a code vulnerability; this is intended, documented, tested design:**
- **Architecture §147 (canon):** *"on the walletless path [`apr`] is null and consumer consent is the
  calling agent's own responsibility."* Agent-asserted consumer identity on the read path is a
  deliberate design decision; authorization/value-binding is enforced at **conversion**, not at read.
- **The PH2-9 test encodes the intent:** `pd-reader.integration.test.ts` reads `/v1/offers` with
  `agent: { agent_id: newId('agt') }` — a FRESH agent that is deliberately NOT the mandate's agent —
  and asserts pd enrichment still flows. mandate_ref alone (not the reading agent) gates it, by design;
  the wallet-UI offers screen relies on the same cross-agent pattern (build-log slice 2a).
- **The security-critical properties hold regardless of asserted identity:** (1) no personal-data
  disclosure — pd never enters any response (`no-1pd-leak` lint rule + the PH2-9 "response carries NONE
  of it" test); it only influences internal `DecisionCtx` ranking. (2) No unauthorised value — bounty
  is attributed to the agent's own `minted.aid` at the trio, wallet-path conversions require
  mandate+approval and the trio re-verifies mandate/limits/approval live at claim time, and a walletless
  conversion charges no consumer. (3) The strongest "leak" is a membership-existence oracle for an
  already-known `sub_hash` via `check_eligibility` — low value.

**Why NOT a same-turn code fix:** a naive binding (require `mandate.agent_id === reading agent`, or
require a verified link for T1) would break the documented walletless model (§147), the tested wallet-UI
cross-agent offers read, and the PH2-9 accept test — i.e. it would change intended behaviour, not close
a bug. That is a product/architecture decision, not a hardening patch.

**Residual → LEAD-5 / product design question (W3-residual, recorded not dropped):** *should member-tier
PRICING and 1pd ranking-enrichment require a verified link (or an agent-bound mandate) rather than pure
agent assertion?* Today a registered agent that asserts a member's identity signal is extended
member-tier pricing and mandate-gated pd ranking without proof of the agent↔consumer relationship —
sound under the current walletless trust model, but worth an explicit product ruling before real-money,
real-merchant exposure (the same gate as SYN-32's LEAD-5 external audit). No code changed; full workspace
was green as of W2 (unchanged since).

---

## W4 (part 1) — Rate-limiting & DoS: control-plane public surfaces + bounded limiter · ✅ 2026-07-06 (findings #2/#4, #11, #12/#22)

**Issue:** the control plane's public POST surfaces had spoofable / missing / unbounded abuse controls.
- **#2/#4 (high)** `/api/signup`'s only control was an in-memory per-IP cap keyed on the *leftmost*
  `X-Forwarded-For` value — fully attacker-controlled, so rotating the header per request bypassed the
  cap entirely and drove unbounded merchant + trio-keypair + published-offer creation.
- **#11 (medium)** that map (and the core `InMemoryRateLimiter`) had no eviction — a rotating-key flood
  grew the heap without bound (OOM).
- **#12/#22 (medium)** `/api/login` had NO limiter — every request forced a ~64 MiB argon2id verify
  (even for unknown emails), a cheap CPU/memory DoS, and TOTP/password were unthrottled.

**Fix:**
- Bounded the core `InMemoryRateLimiter` (`maxKeys`, default 50_000): a new key at the cap sweeps expired
  windows first, then evicts the oldest — memory can no longer be grown by rotating keys.
- New `apps/control-plane/src/lib/rate-limit.ts`: `clientIp()` takes the `X-Forwarded-For` entry
  `CONTROL_PLANE_TRUSTED_PROXY_HOPS`-from-the-**right** (the value the outermost trusted proxy appends —
  an attacker can only prepend on the left), and bounded per-process limiters. Signup = per-IP (20/h)
  **and a global 200/h ceiling** that header rotation cannot bypass (the spoof-proof backstop for the
  expensive path). Login = per-IP (30/5m) **and per-email (10/15m)**, checked BEFORE argon2 so a denied
  attempt costs no hashing. Both return 429 + `Retry-After`. Replaced signup's ad-hoc spoofable map.

**Tests:** core limiter bound test — 10_000 rotating keys keep the map ≤ maxKeys, expired windows swept
(core 256→257). Control-plane `rate-limit.test.ts` (6) — `clientIp` takes the rightmost/trusted-hop entry
and ignores spoofed-left values; per-email login cap throttles one email across varying IPs; **the signup
global ceiling denies even when every request uses a distinct (spoofed) IP** (control-plane 45→51). All
six control-plane e2e suites (login + signup flows) stay green under the new caps. Full workspace: build +
lint clean, all suites pass.

**Security self-review (public-surface abuse controls):**
- *Spoofing?* The per-IP key no longer derives from the attacker-controlled leftmost XFF; the global
  signup ceiling is IP-independent, so header rotation cannot bypass the expensive-path limit.
- *DoS/OOM?* The limiter map is bounded; login throttles precede the memory-hard argon2 verify.
- *Availability trade-off?* Login uses per-IP + per-email (no global cap) so one attacker cannot lock out
  all operators; signup uses a global cap because onboarding is rare and the resource cost is high.
- *Fail-safe?* Limiters are per-process/bounded; a Redis-backed cross-instance limiter is the documented
  production upgrade (launch-readiness A9). No secret or PII enters a limiter key.

**Remaining W4 items (next iteration, part 2):** #23 — throttle the wallet's public magic-link request
endpoint (email bombing); #34 — reject missing-signature webhook deliveries on the cheap header check and
move the per-merchant rate-limit ahead of the secret decrypt (latent until the KMS crypter is wired).

---

## W4 (part 2) — Rate-limiting: wallet magic-link + webhook decrypt-ordering · ✅ 2026-07-06 (findings #23, #34)

**#23 (low) — magic-link email bombing.** `POST /v1/auth/request` (public) called `magicLink.request`
unthrottled — an unauthenticated caller could trigger unlimited sign-in emails to any address (row
inserts + sender-reputation damage once Resend is wired). **Fix:** new `apps/wallet/src/lib/rate-limit.ts`
(a compact self-bounding fixed-window limiter — the wallet is its own service, so no runtime dependency
on `@merited/core`); throttle per source IP (Fastify `req.ip` — the socket peer, not a spoofable header)
and per target email. Over the cap we **silently skip the send and still return the uniform 202**, so the
flood stops *without* adding an address-existence oracle (a 429 would leak per-email state). Caps are
generous for legitimate re-requests (20/15m per IP, 5/15m per email).

**#34 (low, latent) — expensive secret decrypt before rate-limit/auth.** The webhook intake routes fetched
+ decrypted the merchant's active secrets (a KMS call per secret in prod) on every request to a valid
slug, *before* the cheap header/skew checks — so a signature-less flood forced unbounded (paid) decrypts.
**Fix:** extracted the secret-free portion of verification into `precheckWebhook` (signature present →
timestamp present/format → skew) and run it BEFORE `activeWebhookSecrets` in all three routes
(`grade-b/routes.ts`, `protocol/intake.ts`, `commerce/routes.ts` — the last is Shopify's base64 scheme, a
signature-present check). A header-less/stale/malformed delivery is now rejected with the SAME uniform 401
and reason, never touching the Crypter.

**Tests:** `verify.test.ts` (6) — `precheckWebhook` returns each reason and short-circuits before the
secret step; the HMAC round-trip still verifies. Wallet `rate-limit.test.ts` (4) — the limiter bounds a
rotating-key flood; the per-email cap trips across varying IPs. All four webhook intake integration suites
(grade-b/ucp/acp/shopify, 28) stay green — deny reasons unchanged. Full workspace: build + lint clean,
core 257→263, wallet 87→91.

**Security self-review:** *Enumeration?* The magic-link throttle preserves the uniform-202 (silent skip,
no 429 oracle); `req.ip` is the socket peer, not a client header. *DoS?* Both limiters are bounded; the
webhook precheck removes the cheapest amplification (no decrypt for header-less/stale requests) without
consuming the per-merchant rate budget on bad auth (the limiter stays post-verification, so a garbage
flood cannot throttle a merchant's legitimate deliveries). *No behaviour change on the happy path* — the
precheck is the same checks verifyWebhookSignature already did, merely hoisted ahead of the decrypt.
**W4 (rate-limiting overhaul) is now complete** across control-plane, wallet, and core.

---

## W5 — Self-serve signup: privileged side-effects · ✅ 2026-07-06 (product decision + operator kill-switch)

**Assessment (confirm-then-act):** the critic flagged that public `/api/signup` lets an anonymous caller
create a merchant, request a custodied trio keypair, issue a webhook secret and publish a LIVE offer with
zero auth. This is the *intended* PH3-6 feature — "self-serve, zero manual steps," whose accept clause
REQUIRES the offer live in the read path immediately. Requiring pre-verification (email confirm / manual
review) would either break that shipped, gated flow and its tests, or need a new schema+dashboard+email
feature — a product decision, not a security bug. W4 already gives it the proportionate abuse control
(per-IP + spoof-proof global cap on the expensive path).

**Concrete hardening (non-breaking):** added an operator **kill-switch** — `signupEnabled()` reads
`CONTROL_PLANE_SIGNUP_ENABLED`; when set to `"false"` the public surface returns `403 SIGNUP_DISABLED`
before any work. Default (unset / anything else) keeps signup enabled, so PH3-6 and every test are
unchanged. This gives incident response a lever to shut off self-serve onboarding under attack without a
redeploy. Test: `signupEnabled` defaults on and honours explicit off/on (control-plane suite +1).

**Recommendation (product, for LEAD-5 / founder):** if self-serve onboarding should be gated before real
merchants transact, add email-verification or an operator-review state (self-serve merchants land
`unverified`, visible in the dashboard, before their offers enter the read path). Recorded as a product
decision; not silently changed.

---

## W6 — CSRF on state-changing POSTs · ✅ 2026-07-06 (finding #16 + operator-mutation surface)

**Issue (#16, medium):** `/api/login` (and signup, and the ~15 operator mutation routes) took a form POST
with no CSRF token and no Origin/Referer check. SameSite=Lax protects cookie-bearing mutations, but login
needs NO pre-existing cookie — an attacker's auto-submitting cross-site form could silently log an operator
into the ATTACKER's tenant (forced login), after which the operator's work lands in the attacker's account.

**Fix:** an Origin / `Sec-Fetch-Site` check on all state-changing methods (POST/PUT/PATCH/DELETE), applied
in ONE place per app:
- Control-plane: `lib/csrf.ts` `isCrossSite()` in the edge middleware, BEFORE the public-path carve-out —
  so it covers `/api/login`, `/api/signup` AND every guarded operator mutation route at once.
- Wallet: the same check as a global `onRequest` hook (defence-in-depth over SameSite; also covers the
  no-cookie magic-link request).
Policy: reject only on POSITIVE cross-site evidence — `Sec-Fetch-Site: cross-site`, or an `Origin` whose
host ≠ the target host, or a malformed Origin. A non-browser caller (the tests, the valet, the wallet-ui
server-side proxy) sends neither header and passes, so nothing legitimate breaks. Cross-site → `403
CSRF_BLOCKED`.

**Tests:** `csrf.test.ts` in both apps (9) — cross-site / Origin-mismatch / malformed → blocked;
same-origin and no-Origin → allowed. End-to-end: a cross-site `POST /api/login` with `Origin:
https://evil.example` returns 403 and sets no session cookie (control-plane routes e2e); a cross-site
`POST /v1/auth/request` returns 403 while a no-Origin one returns 202 (wallet linking e2e). Full workspace:
build + lint clean, control-plane 51→59, wallet 91→95.

**Security self-review (auth-surface):** *Forced login closed?* Yes — a browser cross-site login POST is
rejected before `authenticate()` runs, so no attacker-tenant session is minted. *False positives?* None on
the happy path — same-origin form posts carry a matching Origin; server-to-server and test clients send no
Origin/Sec-Fetch-Site and are allowed (the documented trade-off — this is Origin-based CSRF, not a
synchroniser token). *Layering:* complements SameSite=Lax (which still covers cookie-bearing mutations) and
the W4 rate limits. HSTS (so the edge upgrades http→https) remains an edge/deploy concern, tracked for W8.

---

## W7 — Finite server timeouts (slowloris / slow-body DoS) · ✅ 2026-07-06 (finding #25)

**Issue (#25, low):** Fastify's `requestTimeout` and `connectionTimeout` both default to `0`
(disabled) on all three Node HTTP hosts — core (`apps/core/src/server.ts`), wallet
(`apps/wallet/src/server.ts`) and trio (`apps/trio/src/shared/server.ts`). With no ceiling, a
client that opens a socket and dribbles headers/body a byte at a time (slowloris / R-U-Dead-Yet)
holds a connection — and a server-side request slot — open indefinitely. Enough slow connections
exhaust the socket/handler pool and starve legitimate traffic, with no code path ever completing to
release the resource.

**Fix:** set finite `requestTimeout: 30_000` and `connectionTimeout: 30_000` (30s each) on every
Fastify instantiation:
- `apps/core/src/server.ts` — alongside the existing `logger`/type-provider options.
- `apps/wallet/src/server.ts` — the wallet host.
- `apps/trio/src/shared/server.ts` — the trio host.
30s is generous for any legitimate request (the largest real payloads here are webhook bodies and
mint requests, all sub-second) while decisively bounding a stalled connection. Size is bounded
separately by Fastify's 1 MiB default `bodyLimit`, so this closes the *time* axis specifically.

**Test:** `apps/core/src/server.test.ts` asserts `createCoreServer().initialConfig.connectionTimeout
=== 30_000` and `.requestTimeout === 30_000` — a regression guard that both timeouts stay finite
(Fastify surfaces both in `initialConfig`, so the assertion is exact, not a proxy). Full workspace:
build + all tests + lint green.

**Note — HSTS (edge concern):** finite timeouts close the slow-request DoS at the app tier;
`Strict-Transport-Security` (which forces the browser to upgrade http→https and thus stops the
plain-HTTP cookie-leak vector noted for W6/W8) is a response-header / edge-proxy concern rather than
a Fastify constructor option, and is tracked for W8's transport-confidentiality work and
`docs/launch-readiness.md` deploy wiring.

---

## W8 — Transport & cache confidentiality · ✅ 2026-07-06 (findings #15/#19, #31 + HSTS)

**Issue A (#15/#19, medium — session-cookie leak):** the wallet set its 30-day session cookie with
`HttpOnly; SameSite=Lax; Path=/` but **no `Secure` flag in any environment** (`wallet/src/server.ts`
verify + logout), unlike the control-plane which already gates `Secure` on production. With no HSTS
either, a single induced plain-HTTP request (a mixed-content beacon, a downgraded link) would put
the session cookie on the wire in cleartext for a network attacker.

**Issue B (#31, low — secret responses cacheable):** the two "shown exactly once" webhook-secret
responses — the control-plane HTML reveal page (`api/merchants/[id]/webhook-secret/route.ts`) and the
self-serve signup JSON (`api/signup/route.ts`, which embeds `webhook_secret`) — carried the plaintext
secret with no `Cache-Control: no-store` and no `Referrer-Policy`, so a shared/browser cache or a proxy
could retain it and an outbound navigation could carry the URL on the Referer header.

**Fix:**
- *Secure cookie (wallet):* a single `serializeSessionCookie()` in `auth/session.ts` builds the
  Set-Cookie header for both mint and clear, appending `Secure` when `walletCookieIsSecure()`
  (`NODE_ENV==='production' && MERITED_ENV!=='dev'` — byte-for-byte the control-plane's gate). Using one
  serialiser for set and clear keeps the attributes identical, which browsers require to match a
  deletion cookie to the one it replaces.
- *HSTS (both cookie-issuing hosts):* production-gated `Strict-Transport-Security:
  max-age=31536000; includeSubDomains`, paired with each Secure cookie — control-plane via
  `applyHsts()` on every middleware response, wallet via a Fastify `onSend` hook registered only when
  `walletCookieIsSecure()`. `preload` is deliberately omitted (enrolling in the browser preload list is
  an irreversible deploy commitment, not app code). The TLS-terminating edge remains the primary place
  to set HSTS; the app-tier header is defence in depth (recorded in `docs/launch-readiness.md`).
- *No-store on secrets (control-plane):* both secret-bearing responses now send `Cache-Control:
  no-store` and `Referrer-Policy: no-referrer` (unconditional — the secret is confidential in every
  environment).

**Tests:**
- `apps/wallet/src/auth/session.test.ts` (4) — `Secure` absent in dev/test, present in production,
  suppressed by `MERITED_ENV=dev`, and the clear cookie carries `Max-Age=0` with matching attributes.
- `apps/control-plane/test/security-headers.test.ts` (3) — HSTS off outside prod, on in prod with the
  exact value (one-year max-age + includeSubDomains, no preload), suppressed by `MERITED_ENV=dev`.
- E2E (against a real `next start` under `NODE_ENV=production`): the signup 201 carries `no-store`,
  `no-referrer` and HSTS (`signup.e2e.test.ts`); the webhook-secret reveal carries `no-store` +
  `no-referrer` (`merchants.e2e.test.ts`).
- Full workspace: build + lint clean; wallet 95→99, control-plane 59→65.

**Security self-review (transport-confidentiality zone):** *Does the cookie ever leave over plain
HTTP in prod?* No — `Secure` is set whenever we are in production, and HSTS forces the browser to HTTPS
before it would even attempt an http request, so both the transmit-time and the downgrade vectors are
closed. *Dev breakage?* None — the gate is identical to the control-plane's existing, tested one;
dev/test over http keeps working (browsers ignore HSTS received over http anyway). *Secret exposure
window closed?* The plaintext secret still appears once in the response body by design (it is never
stored retrievably), but it can no longer be cached by a proxy/browser or leaked via Referer.
*Deletion correctness?* The clear cookie shares the serialiser, so its attributes (incl. `Secure`)
match the set cookie — a partial-attribute mismatch that leaves a stale cookie is avoided. *Residual:*
HTTPS wiring and edge-level HSTS/CSP remain founder/deploy work (`docs/launch-readiness.md`); no keys
or secrets are logged by any of these paths.

---

## W9 — Error-message redaction (no internal-detail / oracle leaks) · ✅ 2026-07-06 (findings #29, #30)

**Issue (#29, low — public signup echoes internals):** the anonymous `/api/signup` catch returned
`error.message` verbatim, so a Postgres constraint string or a trio RPC error reached an unauthenticated
caller. **Issue (#30, low — wallet + MCP echo internals; callback oracle):** four wallet handlers
(`link start`, `link callback`, `mandate grant`, `mandate attenuate`) returned `(error as Error).message`,
and the MCP tool wrapper forwarded any error's message. Worse, the link-callback split its message —
"invalid or expired link state" vs "link state does not belong to this session" — into a **consumer-
ownership oracle**: a caller could tell a valid-but-not-theirs `state` from a bogus one.

**Fix — reuse the safe pattern (core `validation.ts`: known typed error keeps a clean message, unknown →
opaque + logged):**
- *Signup:* split the handler into an **input phase** and a **provisioning phase**. All form parsing runs
  first; its throws are re-tagged `SignupInputError` (they describe the caller's OWN submission, safe to
  surface). Every service call (`merchants.create`, `requestSigningKey`, `issueWebhookSecret`,
  `createDraft`, `publish`) runs after — any throw there is a Postgres/trio internal, redacted to
  `ONBOARDING_FAILED` (500) and `console.error`-logged server-side. Input errors return
  `{ code: 'INVALID_INPUT', message }` (400) — coded, useful, and never an internal string.
- *Wallet (4 handlers):* drop the `message` field entirely; return the code only and `req.log.error` the
  detail server-side. The callback is now uniform (`{ code: 'LINK_CALLBACK_FAILED' }` for both failure
  reasons), closing the oracle. The mandate-attenuate `MANDATE_WOULD_WIDEN` branch keeps its structured
  `violations` (that is intended, safe consent feedback — not an internal error).
- *MCP:* forward a `MeritedApiError` (it carries Core's already-redacted `status + code` — useful for the
  agent to react) but redact any OTHER throw to `"Merited error: an unexpected error occurred"` and
  `console.error` it. The MCP caller owns the agent key, but its LLM context should never see infra detail.

**Tests (negatives alongside each change):**
- `linking.integration.test.ts` (+1) — a failed callback under a valid session returns 401 with
  `code: 'LINK_CALLBACK_FAILED'` and **no `message`** (oracle closed).
- `signup.e2e.test.ts` (strengthened) — a bad input returns `code: 'INVALID_INPUT'` with a message that
  matches **none** of `postgres|relation|syntax|constraint|ECONNREFUSED|at Object` (no internals).
- `apps/mcp-server/test/error-redaction.test.ts` (new) — a dead-port SDK client forces a non-API network
  error; the tool result is exactly the generic line, leaking no host/port/`ECONNREFUSED`/stack.
- Full workspace: build + lint clean; wallet 99→100, mcp-server 5→6, control-plane 65 (assertions
  strengthened in place).

**Security self-review (multiple surfaces).** *Anonymous surface (signup):* an unauthenticated caller can
no longer read a Postgres/trio internal — only a message describing their own input, and only for errors
we explicitly classify as input errors. *Oracle (link callback):* the two failure reasons are now
byte-identical responses, so an attacker cannot distinguish "state exists but isn't yours" from "no such
state"; the W2 ownership check still rejects both. *Useful-feedback preserved:* API-shaped errors that are
already redacted upstream (MCP `MeritedApiError`, mandate widening `violations`) still reach the caller, so
this does not blind legitimate clients. *Server-side visibility:* every redaction path logs the full error
(`console.error` / `req.log.error`) so operability is unchanged — detail moves from the wire to the log,
it is not discarded. *No secrets logged:* the logged errors are exceptions from service calls; none of
these paths touch keys or tokens.

---

## W10 (part 1) — Reserve-before-work idempotency: core `withIdempotency` · ✅ 2026-07-06 (finding #26)

**Issue (#26, low):** `withIdempotency` ran `work()` — the grade-B/UCP/ACP claim funnel that appends a
`ConversionClaimed` ledger event and inserts a `claims_intake` row — BEFORE it reserved the idempotency
key. Two concurrent deliveries of the same key both passed the initial "does the key exist?" check, both
executed the funnel (each with a fresh `claim_id`, `newId('clm')`, so no natural PK dedup), and only then
did one win the `INSERT … ON CONFLICT DO NOTHING`. The response already converged, but the **side-effects
duplicated**: two ledger events + two intake rows for one logical delivery. (Money remained safe — the
trio's jti/qid single-use constraints reject the duplicate downstream — so this was a ledger-integrity
defect, not a money defect.)

**Why not the obvious advisory-lock fix:** serialising with `pg_advisory_xact_lock` would mean holding a
pooled connection across `work()`, and `work()` itself needs pool connections (its `inTx` + the trio HTTP
call). With the core pool capped at 10, ~10 concurrent distinct-key deliveries would each hold a lock
connection and all wait for a work connection that can never free — a self-inflicted deadlock/DoS. Rejected.

**Fix — a genuine reservation row (no held connection, no deadlock):**
- Migration `0013_idempotency_reserve.sql`: make `response_status`/`response_body` nullable (NULL = a
  pending reservation) and `GRANT UPDATE, DELETE` on `core.idempotency_keys` to `merited_app`.
- `withIdempotency` now loops: **reserve** the key first (`INSERT (…request_hash) ON CONFLICT DO NOTHING
  RETURNING`). The winner runs `work()` exactly once, then `UPDATE`s the row with its response. A
  concurrent loser reads the row: a different `request_hash` → 422 `IDEMPOTENCY_CONFLICT`; a completed row
  → converge on the winner's exact stored bytes; a still-pending row → poll (25 ms, ≤10 s) then re-read,
  returning a retryable 409 `IDEMPOTENCY_IN_PROGRESS` only if the winner never finishes in time. If the
  winner's `work()` throws, its pending reservation is `DELETE`d (scoped to `response_status IS NULL`) so a
  retry proceeds — exactly the pre-reservation "failed delivery leaves no key" behaviour.

**Tests:** `grade-b.integration.test.ts` (+1) — two **simultaneous** `Promise.all` deliveries with the same
key both return 200 with byte-identical bodies AND the processor runs **exactly once** (`processed` length
1). The existing contract is unchanged: sequential replay → byte-identical 200, processor once; same key +
different body → 422. The shared helper is exercised by all four adapters — grade-B (6), UCP (9), ACP (9),
under-reporting (3) all green. Full workspace: build + lint clean.

**Security self-review (high-scrutiny zone — adapter claim intake).** *Double side-effect closed?* Yes —
`work()` runs only for the reservation winner, so concurrent duplicates can no longer each append a ledger
event / intake row. *Money-safety unchanged?* The trio's jti/qid dedup still backs this; the fix removes a
ledger-integrity duplicate, it does not relax any settlement check. *Replay/idempotency semantics
preserved?* Byte-identical replay and the same-key-different-body 422 are unchanged and retested. *New
failure modes?* A failed `work()` releases its reservation (DELETE scoped to pending rows only), so a stuck
pending row cannot wedge future deliveries; the 409 in-progress path is retryable and bounded (10 s).
*Privilege expansion?* `merited_app` gains UPDATE/DELETE on `idempotency_keys` only — a non-sensitive table
(request hashes + response bodies); the code only ever UPDATEs its own reservation or DELETEs a row it left
pending. *Secrets/keys?* None are read or logged on this path. **Remaining W10:** wallet approve (#27) and
trio verify (#28) — next tick.

---

## W10 (parts 2 & 3) — Idempotency convergence: wallet approve + trio verify · ✅ 2026-07-06 (findings #27, #28)

Completes W10 (part 1 was core `withIdempotency`/#26). Both remaining layers were check-then-act with no
convergence on a lost race; neither needed a migration.

### Part 2 — wallet `approve` (#27)

**Issue:** `ApprovalsService.approve` checked `wallet.idempotency_keys`, ran `approveOnce()` (which
re-**mints** a fresh jti/token for the qid), then `INSERT … ON CONFLICT (idem_key) DO NOTHING` — but
**returned its own result**. Two concurrent same-key calls therefore each minted a token and returned a
DIFFERENT token for one approval, breaking the single-token invariant. (The approval itself is already
qid-idempotent — `wallet.approvals` has `UNIQUE(quote_id)` and `recordApproval` re-reads the winner's
approval — so only the re-mint/response diverged.)

**Fix (convergence — the plan's sanctioned minimum):** on a lost insert race (`rowCount === 0`), re-read
the stored response (scoped to `consumer_ref`) and return **that**, so both callers converge on one token.
The loser's re-minted token is orphaned but harmless: SYN-9 + the trio's jti/qid single-use consumption
(hardened in part 3) guarantee exactly one token per qid ever converts, so the wasted mint can never
double-spend. Reserve-before-work would additionally suppress the orphaned mint, but the re-mint is an
un-rollbackable trio HTTP call, so preventing it would need the full pending-reservation machinery for a
purely cosmetic gain — disproportionate given SYN-9 already neutralises the money risk.

### Part 3 — trio `verify` (#28)

**Issue:** the verdict transaction ended with a bare `INSERT INTO trio.idempotency_keys …` (no
`ON CONFLICT`). A concurrent same-key verify — serialised on the commitment counter lock — would find the
token already consumed, compute `TOKEN_REPLAYED`, append a `ConversionRejected`, then hit the idempotency
PK → throw → **500**. A naive `ON CONFLICT DO NOTHING` would have been worse: the loser's transaction would
COMMIT, leaving a **spurious `ConversionRejected`** alongside the winner's `ConversionVerified`, and would
return its own wrong verdict.

**Fix:** store the verdict via `INSERT … ON CONFLICT (scope, key) DO NOTHING` inside the verdict tx; if it
inserts 0 rows a concurrent winner already stored the verdict, so throw a private `IdempotencyRaceLost` —
`inTx` rolls the transaction back (discarding the loser's events), and the caller re-reads and returns the
**winner's** stored verdict (or 422 on a genuine hash mismatch). Only the winner reaches the post-commit
replay-cache mark. No migration; the frozen trio contract suite (packages/contracts) is untouched.

**Tests (concurrency negatives):**
- `approvals.e2e.test.ts` (+1) — two `Promise.all` approves with one key both return `approved` with the
  **same** `token`, equal to the single stored response.
- `verify.integration.test.ts` (+1) — two `Promise.all` verifies with one key converge on one verdict
  (`verified`), post **exactly one** `ConversionVerified` and **zero** new `ConversionRejected`.
- Sequential idempotency contracts (byte-identical replay, same-key-different-body 422) unchanged and still
  green. Wallet 100→101, trio 16→17 in the touched suites; full workspace build + lint clean.

**Security self-review (high-scrutiny — wallet consent + trio verify).** *Single-token invariant restored?*
Yes — concurrent approves return one token; concurrent verifies return one verdict. *Money-safety
unchanged?* The trio's counter lock + jti single-use consumption still decide verified-vs-replayed; the fix
only changes what a *duplicate* caller receives (the winner's verdict) and removes a spurious rejection
event — it never relaxes a settlement check or lets a second token convert. *Rollback correctness?* The
loser's `inTx` fully rolls back on `IdempotencyRaceLost`, so no partial/duplicate `ConversionRejected` or
counter write survives. *Oracle/leak?* The converged responses are the winner's own bytes for the same
consumer/key — no cross-tenant data crosses (the wallet re-read is `consumer_ref`-scoped). *Replay
semantics?* Sequential replay and the 422 conflict are preserved and retested. *Secrets/keys?* None read or
logged on these paths. **W10 complete.**

---

## W11 (part 1) — Consistency: suspension bites the webhook rail + uniform claim-refusal · ✅ 2026-07-06 (findings #35, #33)

**Issue (#35, low — suspension didn't bite the webhook path):** `authenticate()` filters `m.status =
'active'`, so a suspended merchant's agent/merchant API access stops. But the webhook-intake rails resolve
the merchant via `getBySlug`, which had no status filter — so a suspended merchant's `order-confirmed`
deliveries were still accepted and funnelled into claims. **Issue (#33, low — claim existence oracle):**
`GET /v1/claims/:id` returned 404 `CLAIM_NOT_FOUND` for an unknown id but 401 `CLAIM_ACCESS_DENIED` for an
existing-but-not-yours one, letting a caller probe which `claim_id`s exist without owning them — unlike the
platform's uniform-401 convention.

**Fix:**
- #35: `getBySlug` now selects `WHERE slug = $1 AND status = 'active'`. Its only callers are the three
  webhook rails (grade-B, commerce, protocol), so a suspended merchant's deliveries now 404 inside the
  handler → the existing `deny('merchant_unknown')` → uniform 401, identical to an unknown slug (suspension
  is not distinguishable from non-existence either).
- #33: the claims GET computes ownership only when the row exists, then returns a single `401
  CLAIM_ACCESS_DENIED` for BOTH `!row` and `!authorised` — unknown and unauthorised are byte-identical.

**Tests:**
- `grade-b.integration.test.ts` (+1) — a fresh merchant's correctly-signed webhook is accepted (200) while
  active, then the SAME signed delivery is refused (401 `WEBHOOK_AUTH_FAILED`) once suspended.
- `claims-api.integration.test.ts` (updated) — an unknown claim with a valid merchant key now returns 401
  and the body is byte-identical to the anonymous refusal (the old test asserted 404 — updated to lock in
  the closed oracle, not weakened).
- Full workspace: build + lint clean.

**Security self-review (webhook rails + claim access).** *#35 — does suspension now bite everywhere?* Yes —
both the API path (`authenticate`) and all three webhook rails (`getBySlug`) require `status = 'active'`; a
suspended merchant can neither call the API nor deliver webhooks. *Any legitimate caller broken?* No —
`getBySlug` is used only by webhook intake, which should reject suspended merchants; admin/dashboard reads
use `get(merchantId)`/`list()`, which are unchanged. *#33 — oracle fully closed?* Unknown and
not-yours now return the same status AND the same body; a residual *timing* difference remains (an existing
claim runs the ownership queries) — noted as acceptable, matching the platform's other uniform-401 surfaces,
and far weaker than the removed status split. *Secrets/keys?* None read or logged. **Remaining W11:**
dev-secret fail-fast + web-push SSRF (contracts-first) — same tick.

---

## W11 (part 2) — Dev-secret fail-fast (no silent public defaults in production) · ✅ 2026-07-06 (critic gap)

**Issue:** three control-plane secrets fell back to a hard-coded default baked into the source tree —
`sessionSecret() ?? 'control-plane-dev-secret'` (cookie-sign.ts), `signerSecret ?? 'trio-dev-secret'` and
`serviceToken ?? 'dev-service-token'` (platform.ts). If the env var were unset in production the app would
**silently run on a publicly-known secret**: the session HMAC key becomes guessable (forgeable operator
cookies → full dashboard access) and the inter-service token becomes known (impersonate the control-plane
to the trio). A missing env var should be a loud failure, not a silent downgrade.

**Fix:** a shared `secretFromEnv(envVar, devFallback)` (apps/control-plane/src/lib/require-secret.ts):
returns the env value when set; outside production returns the dev fallback (dev/test unchanged); **in
production (`NODE_ENV==='production' && MERITED_ENV!=='dev'`, the same gate as the W8 Secure cookie/HSTS)
throws** when unset. Applied to all three call sites. It uses only `process.env`, so it is safe in the Edge
middleware where `sessionSecret()` runs.

**Tests:** `require-secret.test.ts` (4) — env value wins in any environment; dev falls back; **production +
unset → throws** (`/must be set in production/`); `MERITED_ENV=dev` re-opens the fallback under
`NODE_ENV=production`. The three prod-mode e2e suites that instantiate `getMerchantsService()` without these
env vars (claims, dashboard — routes.e2e never touches it) now set `MERITED_SIGNER_SECRET` /
`MERITED_TRIO_SERVICE_TOKEN` explicitly, to the former fallback values, so their behaviour is unchanged —
which also proves a correctly-configured deployment is unaffected. Full workspace build + lint clean.

**Security self-review (secret handling).** *Fail-closed in prod?* Yes — an unset secret now aborts at
first use instead of adopting a source-tree default. *Dev/test friction?* None — the fallback still applies
whenever `NODE_ENV!=='production'` (or the explicit `MERITED_ENV=dev` escape hatch). *Escape hatch abuse?*
`MERITED_ENV=dev` is a deliberate operator choice, logged as config; it only widens the fallback, never
narrows security. *Secrets logged?* No — the throw names only the ENV VAR, never a value; no secret is
printed. *Coverage?* All three control-plane fallbacks are converted; the only other `?? '…-secret'`
occurrence is a `contract-tests/harness.ts` test-only signer, correctly left as-is. **Remaining W11:**
web-push SSRF guard (contracts-first) — next tick.

---

## W11 (part 3) — Web-Push SSRF guard (contracts-first) · ✅ 2026-07-06 (critic gap) · **W11 COMPLETE**

**Issue:** `PushSubscription.endpoint` was validated only as `z.string().url()`. The endpoint is a URL the
wallet POSTs a VAPID-signed request to (`webpush.sendNotification`), so a consumer could register
`http://169.254.169.254/latest/meta-data/…` (cloud metadata) or any internal/loopback host and turn the
wallet into a blind SSRF proxy — reaching internal services or metadata endpoints with an authenticated
POST it would never otherwise make.

**Fix (contracts-first, §1):** a refinement on `PushSubscription.endpoint` in `packages/contracts/src/push.ts`
via an exported `isPublicHttpsEndpoint(url)` — require `https:` and reject non-public hosts: `localhost` /
`.localhost` / `.local` / `.internal`; IPv4 loopback/private/link-local/CGNAT/`0.` literals (incl. the
`169.254.169.254` metadata address); and IPv6 loopback/unspecified/link-local/unique-local + every
IPv4-mapped (`::ffff:…`) literal. IPv6 rules are gated on the host containing a colon, so a hostname such as
`fcm.googleapis.com` is never mis-matched against `fc00::/7`.

**Wallet consumes it (two gates):** the subscribe route already `safeParse`s → a bad endpoint now returns
`400 PUSH_SUBSCRIPTION_INVALID` at ingestion. The send loop's `PushSubscription.parse` (previously outside
the try — one bad row would crash the whole send) is now a `safeParse` that **skips and prunes** any stored
row failing the guard, so even an endpoint injected past the API is never delivered to and never breaks
delivery to the consumer's good subscriptions.

**Tests:** `packages/contracts/src/push.test.ts` (6, new) — a normal `https://fcm.googleapis.com/…` and
public IPv4 accepted; http/ftp/file rejected; metadata + loopback + private + CGNAT IPv4 rejected; localhost
and internal-suffix hostnames rejected; IPv6 loopback/link-local/ULA/mapped rejected. Existing
`phase1.test.ts` PushSubscription (public https) still green; wallet push integration (6) green. Full
workspace build + lint clean.

**Security self-review (SSRF / contracts-first).** *SSRF closed at ingestion AND at send?* Yes — the schema
refinement runs in `safeParse` on the subscribe route (400) and again in the send loop (skip+prune), so the
wallet never POSTs a VAPID request to a non-public literal. *Contracts-first honoured?* The validation lives
in `packages/contracts` (the single source, §1); the wallet consumes it, adds no divergent copy. *Frozen
suite?* `push.ts` is a wallet/push contract, not the frozen trio contract suite — untouched. *Residual —
DNS rebinding:* a hostname that RESOLVES to a private IP is invisible to a static schema; a runtime
resolve-then-check / egress allowlist is required before real Web Push goes live — logged as
`docs/launch-readiness.md` A16 (gated on A5). *Legit traffic?* All real push endpoints are public https, so
no legitimate subscription is refused; the test fixtures (`https://push.example/…`) still pass. **W11 fully
complete (parts 1–3).**

---

## W12 — Reference verifier trust anchor (a forged pack can no longer self-certify) · ✅ 2026-07-06 (finding #3) · **P2 COMPLETE**

**Issue (#3, high — pre-launch/latent, but defeats the PH3-8 gate claim):** the offline reference verifier
(`packages/verifier`) anchored the ledger slice to `pack.heads` — a field of the SAME untrusted pack — and
verified the platform COR countersign + token mint with `pack.keys.*`, also from the pack. So a fully
self-consistent proof pack, with a chain the attacker re-hashed themselves, its own computed head in
`pack.heads`, and every signature made with the attacker's OWN keys (whose publics they put in `pack.keys`),
reported **VERIFIED**. The verifier's entire purpose — letting a third party confirm a conversion WITHOUT
trusting Merited — was void. (The trio's live verify path is unaffected: it uses its custodied mint key, not
pack-supplied keys.)

**Fix — the trust anchor is a SEPARATE, caller-supplied input:**
- `verifyProofPack(input, trust: TrustAnchor)` gains a required `TrustAnchor = { heads[], platform:
  { commitment_public_key, mint_public_key } }`. It is validated and **fail-closed**: a missing/empty anchor
  is `INVALID` before any pack check.
- The slice must anchor to `trust.heads` (the auditor's head from the trusted append-only heads store), NOT
  `pack.heads`. A forged chain cannot match a head it does not control.
- The platform COR countersign and the PASETO mint verify against `trust.platform.*` (the out-of-band key
  manifest), never the pack's copies — so attacker keys cannot self-certify. (The merchant key stays
  pack-carried: it is cross-checked by the platform countersign + byte-equal anchoring in the trusted chain.)
- `cli.ts` now requires `--trust <anchor.json>` (heads + platform keys); without it the CLI refuses (exit 1).
  `index.ts` exports `TrustAnchor`. The PH3-8 clean-container evidence doc is updated to mount + pass it.

**Tests (`verifier.integration.test.ts`, 8→9 + reshaped):**
- **FULL FORGERY (new):** a self-consistent slice that re-chains its own events, points `heads` at its
  forged tip and swaps in a freshly-generated attacker Ed25519 key for all three key slots → `INVALID`
  (`chain`, "not anchored") when verified against the auditor's real anchor. This is the exact attack #3
  described, now provably closed.
- **No trusted anchor (new):** empty heads, and calling without the anchor, → `INVALID` (fail closed).
- The genuine gate clause still `VERIFIED`; byte-tamper, forged-amount, swapped-merchant-key, dev-fake-token
  and the REJECTED-verdict cases all still fail/report correctly, now threaded through the real anchor. CLI:
  `--trust` → exit 0 VERIFIED; no `--trust` → exit 1. Full workspace build + lint clean.

**Security self-review (HIGH-SCRUTINY — the verifier).** *Forgery closed?* Yes — a self-consistent pack with
its own head + attacker keys is rejected at the anchor step; the new test proves it. *Trust model correct?*
The verifier now trusts ONLY two out-of-band inputs (published head + platform keys) and derives everything
else from the pack, pinned to the trusted chain by hash. *Fail closed?* A missing/malformed anchor is
`INVALID`, never a pass. *Residual pack-supplied trust?* Only the merchant public key — and it is constrained
by the platform countersign (trusted key) and byte-equal anchoring of the COR/claim in the trusted chain, so
it cannot forge a verdict. *False negatives on genuine packs?* None — a real pack whose slice anchors to the
real head and whose sigs match the real platform keys still `VERIFIED` (gate clause + CLI green). *Offline
invariant kept?* The verifier still imports nothing from core/trio/events and makes no network calls; the
anchor is supplied as data. *Live path?* Unchanged — this is the offline reference verifier only. **P2
(W8–W12) is complete; P3 (accessibility) and P4 (CI) remain.**

---

## W13 (part 1) — Accessible error announcement: login + wallet linking · ✅ 2026-07-06 (findings #7, #9)

**Issue (SC 3.3.1 Error Identification / SC 4.1.3 Status Messages):** two failure paths redirected with a
query flag that the page then dropped on the floor — a sighted user saw an unchanged form, a screen-reader
user got nothing at all. #7: control-plane `/login` did `void searchParams`, discarding `?failed=1` from the
login route's uniform-refusal redirect. #9: the wallet `/accounts` page ignored `?link_failed=1` set by the
link-start route when the brand sign-in cannot begin.

**Fix:** each page now reads the flag and renders an in-page `role="alert"` region (announced by assistive
tech) that identifies the problem in TEXT (a bold lead-in + guidance), not by colour alone:
- `login/page.tsx` (control-plane, light theme) — `?failed=1` → "Sign-in failed. Check your email, password
  and one-time code…". Credentials are never echoed back (the refusal stays uniform; no field is preserved
  in the URL — a deliberate non-regression of the security posture).
- `accounts/page.tsx` (wallet-ui, dark theme) — `?link_failed=1` → "Couldn't start linking. Check the
  merchant id and programme…". Alert colours chosen for AA contrast on each theme (dark-red on pink /
  light-pink on dark-red).

**Tests:** `routes.e2e.test.ts` (+1) — `GET /login?failed=1` contains `role="alert"` + "Sign-in failed",
and the clean `/login` has no alert. `ui.e2e.test.ts` (+1) — `GET /accounts?link_failed=1` (authenticated)
contains `role="alert"` + "start linking", and the clean page has none. Full workspace build + lint clean.

**Note:** #8 (signup validation errors rendered as raw JSON on a separate URL) is W13 part 2 — it needs a
client-side presentation layer because the `/api/signup` JSON contract is consumed verbatim by the PH3-6
gate e2e (which must not change), so the accessible in-page error is added WITHOUT altering the API response.

---

## W13 (part 2) — Accessible signup errors (in-page, not raw JSON) · ✅ 2026-07-06 (finding #8) · **W13 COMPLETE**

**Issue (SC 3.3.1 / 4.1.3):** the signup form POSTed straight to `/api/signup` and the browser NAVIGATED to
the raw JSON response — a validation failure showed `{"error":{...}}` on a bare URL with no heading, no field
association, and every entered value lost; a screen reader announced nothing useful.

**Constraint:** the `/api/signup` JSON response is consumed verbatim by the PH3-6 gate e2e (fresh signup →
201 with the integration sheet, bad input → 400 `INVALID_INPUT`), so the API must NOT change. The fix is a
PRESENTATION layer only.

**Fix:** the form is now a client component (`SignupForm.tsx`) that submits via `fetch`, keeping the API and
its W8 `no-store` headers intact:
- On failure it renders an in-page `role="alert"` with a human message and the form still visible — entered
  values are preserved (uncontrolled inputs, no navigation). The message comes from a pure, unit-tested
  `messageForError` (`signup-error.ts`): `INVALID_INPUT` surfaces its own already-redacted (W9) message;
  every other code maps to a safe sentence; unknown/`ONBOARDING_FAILED` internals are never echoed.
- On success it renders the one-time integration sheet in-page (`role="status"`) — merchant id, webhook
  endpoint, and the secret shown exactly once — instead of dumping JSON.
- Date defaults are computed server-side and passed as props (no `Date.now()` hydration mismatch).

**Tests:** `signup-error.test.ts` (3) — `INVALID_INPUT` message surfaced verbatim; each coded failure → a
safe sentence; unknown code / null / an `ONBOARDING_FAILED` internal string → generic, never leaked.
`signup.e2e.test.ts` (strengthened) — the page SSRs the form ("Trading name"/"Go live" in the initial HTML);
the API's 201/400/no-store behaviour is unchanged (the gate posts to it directly). Full workspace build +
lint clean. **W13 complete (#7, #8, #9).**

---

## W14 — Contrast & colour (WCAG AA) · ✅ 2026-07-06 (findings #6, #18; SC 1.4.1 audited)

**Issue (SC 1.4.3 text contrast — #6):** the merchant-health badge set only a dark `background` and inherited
the control-plane's default BLACK page text, so "✅ Healthy" etc. rendered black-on-dark at **1.70:1**
(measured) — well under the 4.5:1 minimum. **Issue (SC 1.4.11 non-text contrast — #18):** the wallet-ui
input/select border was `#1f2a24` on page `#0b0f0d` at **1.23:1** — the fields were nearly invisible; the
3:1 boundary minimum was missed.

**Fix (values measured with the WCAG relative-luminance formula, not guessed):**
- #6: each badge now sets an explicit `color: #ffffff`. White on the three dark badge backgrounds measures
  **12.35:1 / 13.15:1 / 12.63:1** (`#0a3d1f` / `#5a1a1a` / `#333333`). The palette moved to
  `lib/health-badge.ts` so the contrast is unit-tested.
- #18: the input/select border is now `#5f8873` — **4.59:1** against the field fill `#101613` and **4.83:1**
  against the page `#0b0f0d`, clearing 3:1 comfortably while staying in the green theme.

**SC 1.4.1 (colour-not-sole) — audited, already satisfied:** every status in the apps is rendered as a TEXT
label — merchant `Status: {status}`, offers `{o.status}`, signing keys `revoked`/`live`, wallet links
`{link.status}` — and the health badge carries an emoji + words. No status is conveyed by colour alone, so
no change was required; a defensive test asserts the badge labels keep a non-colour cue.

**Tests:** `health-badge.test.ts` (2) — every badge foreground clears **≥4.5:1** against its background
(computed in-test), and every label carries an emoji + words. `ui.e2e.test.ts` (strengthened) — a rendered
page's layout `<style>` uses the AA input border `#5f8873` and no longer the old `#1f2a24`. Full workspace
build + lint clean. **Remaining P3: W15 (structure & wayfinding).**

---

## W15 — Structure & wayfinding (WCAG AA) · ✅ 2026-07-06 (findings #17, #36 + focus-ring + skip-link) · **P3 COMPLETE**

**Fixes:**
- **#17 (SC 1.3.1):** the claim "Audit path" table used `<td>` for the row LABELS (Claim / jti / qid / cid),
  so assistive tech couldn't associate each value with its name. Each label is now `<th scope="row">`.
- **#36 (SC 2.4.2):** every wallet-ui screen shared the single layout title "Merited Wallet". The layout now
  defines a title TEMPLATE (`%s · Merited Wallet`) and each of the 8 routes exports its own `metadata.title`
  ("Your wallet", "Linked accounts", "Offers for you", "Approve payment", "Valet mandate", "Valet errands",
  "Activity & settlement", "Sign in") — distinct, descriptive per-page titles.
- **Focus visibility (SC 2.4.7 / 2.4.11):** both apps now set an explicit `:focus-visible` outline (2px,
  offset) — `#6ee7b7` on the wallet-ui dark theme and `#1d4ed8` (6.5:1) on the control-plane light theme —
  instead of relying on the unreliable UA default.
- **Skip link (SC 2.4.1):** both layouts render an off-screen "Skip to content" link (revealed on focus)
  that jumps to a `#main-content` wrapper around the page — keyboard users bypass the repeated nav.

**Tests:** `claims.e2e.test.ts` (strengthened) — the audit rows render `<th scope="row">…</th>` for the
labels, and the skip link + `#main-content` are present. `ui.e2e.test.ts` (+1) — `/accounts` and `/offers`
carry DISTINCT `<title>`s ("Linked accounts · Merited Wallet" vs "Offers for you · Merited Wallet"), and the
skip link + `#main-content` ship on the page; plus the W14 border assertion. Full workspace build + lint
clean. **P3 (W13–W15) complete; only P4 (W16 CI supply-chain) remains.**
