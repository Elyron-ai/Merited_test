# Merited — Platform Build Specification

**Version:** 1.1 · July 2026
**Audience:** Claude Code (this file lives at the repo root; treat it as the canonical build brief)
**Companions:** `merited-platform-architecture.md` v1.1 (design rationale) · `merited-architecture.html` (visual + vendor map)

> **v1.1 additions:** **Valet** — the named first-party commerce agent with an errand state machine (B17/B18 revised); **Account Linking** — OAuth-consented loyalty identity with the FakeAurora IdP (B23); **Quote Service** — quote-bound tokens and priced responses (B24); **Notifications & Approvals** — Web Push + signed approval records in the token chain (B25/B26); demo brand **Aurora Experiences / Aurora Club**; the demo becomes **two acts** — walletless (Phase 0) and wallet (Phase 2).

> **Naming note:** the brand is **Merited** (supersedes Elyron everywhere — code, packages, env vars, copy). Package scope `@merited/*`. Env prefix `MERITED_`.

---

## 0. How to use this spec

1. **Build in phase order** (§9). Do not start a later-phase module while an earlier-phase acceptance test fails.
2. **Every third-party dependency sits behind an adapter interface with a fake** (§2). Build the first-party code against the fake; wire the real vendor only at the integration milestone. The build must never block on a vendor account existing.
3. **The security-critical trio (★) is contract-only for Claude Code** (§7). Build the TypeScript interfaces, schemas, HTTP contracts, simulators, and test suites — do **not** implement production cryptography, key handling, or ledger-posting logic. Those implementations are the senior developer's ~4-week scope. The simulators must be behaviourally faithful (same API, same error codes, deterministic fake signatures) so everything above them is testable end-to-end before the senior dev starts.
4. **UK English** in all user-facing copy. Currency in integer pence (`GBP_pence`), never floats.

---

## 1. Stack & repo layout

**Decisions (fixed):** TypeScript everywhere · Node 22 · Fastify for HTTP · Postgres 16 (single instance, multiple schemas; the trio gets its own logical database in prod) · Drizzle ORM + raw SQL for ledger paths · Redis (replay cache, rate limits — never source of truth) · Next.js 15 for control plane + wallet UI · Vitest · Zod for all runtime validation · OpenTelemetry from day one.

```
merited/
├── BUILD-SPEC.md                  ← this file
├── docker-compose.yml             ← postgres, redis, fake-kms, mailpit
├── packages/
│   ├── contracts/                 ← Zod schemas + TS types for EVERYTHING (single source of truth)
│   ├── events/                    ← event definitions, outbox writer, ledger reader
│   ├── signing/                   ← signing INTERFACE + FakeSigner (real impl: senior dev)
│   └── sdk/                       ← thin typed client for the public agent API
├── apps/
│   ├── core/                      ← the monolith (modules below as folders, not services)
│   │   └── src/modules/
│   │       ├── offers/            ├── identity/         ├── eligibility/
│   │       ├── decisioning/       ├── guardrails/       ├── agents/
│   │       ├── merchants/         ├── adapters/         ├── analytics/
│   │       └── token-client/      ← client to the mint (mint itself lives in trio)
│   ├── trio/                      ← ★ commitment / verification / settlement (contracts + sims here;
│   │                                 real impls replace sims in-place, senior dev)
│   ├── control-plane/             ← Next.js internal admin (merchant ops)
│   ├── wallet/                    ← Next.js consumer wallet + wallet API
│   │   └── src/modules/
│   │       ├── linking/           ← OAuth account-linking flows (Identity Links)
│   │       ├── mandates/          ← consent & mandate service
│   │       ├── notifications/     ← Web Push (VAPID) + approval screens
│   │       └── pd-store/          ← consented 1PD
│   ├── valet/                     ← the first-party agent: errand state machine
│   │                                (Ph 0: scripted core, walletless · Ph 2: wallet-driven, LLM brief)
│   ├── mcp-server/                ← Phase 1 agent surface
│   └── fake-aurora/               ← demo brand: Aurora Club OIDC IdP + loyalty API + FakeShop storefront
└── tools/
    ├── seed/                      ← Aurora Experiences seed data (merchant, offers, memberships, members)
    └── demo/                      ← the end-to-end demo scripts — Act 1 walletless (Ph 0), Act 2 wallet (Ph 2) (§10)
```

Rule: **`packages/contracts` is the only place types are defined.** Core, trio, wallet, SDK, and tests all import from it. A contract change is a PR that touches `contracts` first.

---

## 2. Build vs integrate — the demarcation

### 2.1 First-party build (yours, via Claude Code)

| # | Element | Phase | Notes |
|---|---|---|---|
| B1 | Contracts package (all schemas/types) | 0 | Foundation — build first |
| B2 | Event ledger: append-only table, hash-chaining, outbox, projections | 0 | Storage + chaining logic is buildable; only *signing* is trio scope |
| B3 | Offer Service — 27 offer types, one schema, discriminated `mechanics` union | 0 | |
| B4 | Agent Registry — registration, `agt_*` IDs, API keys, verified-agent token issuance | 0 | Key-signed requests upgrade in Ph 1 |
| B5 | Identity Resolution — T1/T2/T3 pure-function resolver | 0 | Ph 0 uses a static membership table (seeded), not Eagle Eye |
| B6 | Eligibility Engine — deterministic filters | 0→1 | Ph 0: liveness + tier + counters; Ph 1: rules, stacking, exclusions |
| B7 | Decisioning Slot — `rank()` interface + v1 rules ranking | 1 | v2 ML sidecar is a later drop-in behind the same interface |
| B8 | Guardrails — margin floor, budget pacing λ, brand rules | 1→2 | |
| B9 | Public agent REST API (`readOffers` path) + SDK | 0 | The canonical read path everything else wraps |
| B10 | MCP server surface | 1 | Tools: `search_offers`, `get_offer`, `check_eligibility` |
| B11 | JSON-LD offer feed (schema.org/Offer) | 3 | Anonymous = untokenised |
| B12 | Grade-B merchant webhook adapter (inbound order → Conversion Claim) | 0 | The design-partner integration |
| B13 | Merchant Control Plane (internal admin: onboarding, offer authoring, commercial config) | 0→1 | Thin; hand-onboarding is fine |
| B14 | Consent & Mandate service — signed mandates, attenuation, live revocation | 1 | Strategic even though the wallet is a demo |
| B15 | Wallet backend — profile, Identity Links, 1pd store, points read models | 1→2 | |
| B16 | Wallet UI — six-screen sales-engineering demo (§6.3) | 2 | M4–M5 per roadmap |
| B17 | **Valet (full)** — errand state machine driven from the wallet: brief → quote → notify → approve → execute → confirm; LLM brief-interpreter optional | 2 | Ordinary registered agent `agt_valet_*`; no privileged access |
| B18 | **Valet v0** — Phase 0 scripted core: walletless errand end-to-end against FakeShop | 0 | Same state machine, no wallet states (approval auto-skipped) |
| B19 | Analytics read models + mint-vs-claim monitoring | 1→2 | Projections off the ledger; merchant dashboard UI in Ph 2 |
| B20 | Trio **simulators** + full contract test suites | 0 | Behaviourally faithful fakes (§7) |
| B21 | Observability wiring — OTel traces spanning read→token→claim→verdict→ledger | 0 | This trace *is* the demo asset |
| B22 | Seed + demo tooling | 0 | §10 |
| B23 | **Account Linking service** — OAuth 2.1 code+PKCE client, Identity Link records, revocation, encrypted refresh-token store; hosted-linking fallback (verification-email) | 1 | The T1 key; senior-dev review on token storage |
| B24 | **Quote Service** — priced OfferQuote responses, quote expiry, quote-bound token minting, quote lookup | 0 | The read path's response unit (§4) |
| B25 | **Notifications** — Web Push (VAPID) from wallet backend, quote notification payloads, deep links | 1 | First-party; no vendor |
| B26 | **Approvals** — signed Approval records (explicit + pre-authorised), single-use, quote-bound, `apr` claim re-mint flow | 1 | Verification checks approval on wallet-path claims |
| B27 | **FakeAurora** — demo brand in a box: Aurora Club OIDC IdP, loyalty API (members, tiers, balances, points-credit), FakeShop storefront/checkout | 0→1 | IdP + loyalty API land Ph 1 with B23; storefront lands Ph 0 |

### 2.2 Third-party integrations (adapter + fake; wire later)

| Vendor · product | Adapter interface | Fake for local dev | Wire-up phase |
|---|---|---|---|
| AWS KMS | `Signer` (`sign`, `verify`, `getPublicKey`) | `FakeSigner` (deterministic HMAC-tagged pseudo-sigs) | 0 (senior dev) |
| Neon/RDS Postgres | none needed (Postgres is Postgres) | docker-compose | 0 |
| Upstash Redis | `ReplayCache`, `RateLimiter` | docker-compose Redis | 0 |
| Resend | `Mailer` | mailpit container | 1 |
| Shopify (app, cart attributes, orders/paid) | `CommerceAdapter` | `FakeShop` — Aurora's sandbox storefront inside `apps/fake-aurora` (**build this; it's B18's counterpart**) | 1–2 |
| Brand identity providers (OAuth2/OIDC — Auth0, Cognito, merchant-native) | `IdentityProviderAdapter` (authorize, exchange, refresh, userinfo, revoke) | `FakeAurora` OIDC IdP (B27) | 1 |
| Eagle Eye AIR | `LoyaltyLookup` (member lookup, tier, balance, points-credit) | `FakeAurora` loyalty API / static membership table | 1–2 |
| Salesforce Commerce Cloud | `CommerceAdapter` (same interface as Shopify) | — | 2–3 |
| Stripe Connect | `PayoutRail` (`createAccount`, `transfer`, `reverse`) | `SimulatedPayouts` (statements only — this *is* the Ph 1 behaviour, not just a fake) | 2 |
| Anthropic MCP | protocol, not adapter — B10 implements the spec | MCP inspector locally | 1 |
| Google UCP / OpenAI ACP | `ProtocolAdapter` (offer-out, checkout-callback-in) | contract stubs only | 3 |
| Axiom/Grafana, Sentry | standard OTel/Sentry SDKs | console exporter | 0 |

**Never build first-party:** payment processing, KYC/KYB, card storage, email deliverability, key storage hardware. These are precisely the things vendors exist for and where DIY creates regulatory or security liability.

---

## 3. Contracts package — the core objects

All Zod-first. Canonical IDs: prefixed ULIDs (`mer_`, `off_`, `com_`, `agt_`, `atk_`, `clm_`, `mnd_`, `usr_`, `evt_`).

```ts
// Money
const Money = z.object({ amount: z.number().int().nonnegative(), currency: z.literal('GBP_pence') });

// Offer — ONE table, ONE schema, discriminated mechanics union (do not build 27 tables)
const OfferMechanics = z.discriminatedUnion('type', [
  z.object({ type: z.literal('percentage_off'), pct_bps: z.number().int() }),
  z.object({ type: z.literal('fixed_off'), value: Money }),
  z.object({ type: z.literal('points_multiplier'), multiplier_x100: z.number().int() }),
  z.object({ type: z.literal('points_bonus'), points: z.number().int() }),
  z.object({ type: z.literal('tier_unlock'), tier: z.string() }),
  z.object({ type: z.literal('welcome_bonus'), value: Money }),
  z.object({ type: z.literal('bundle'), sku_refs: z.array(z.string()), value: Money }),
  // ...extend to the full 27; each variant ≤ 5 fields; if a variant needs more, it's two variants
]);

const Offer = z.object({
  offer_id: Id('off'), merchant_id: Id('mer'),
  title: z.string(), description: z.string(),
  mechanics: OfferMechanics,
  sku_scope: z.union([z.literal('all'), z.array(z.string())]),
  identity_tiers: z.array(z.enum(['T1','T2','T3'])),
  stacking_group: z.string().nullable(),
  status: z.enum(['draft','live','paused','ended']),
  valid_from: z.string().datetime(), valid_until: z.string().datetime(),
});

// Committed Offer Record — immutable once countersigned (trio owns creation)
const Commitment = z.object({
  commitment_id: Id('com'), merchant_id: Id('mer'), offer_ref: Id('off'),
  bounty: z.object({ type: z.enum(['fixed','pct_of_order']), amount: Money.optional(), pct_bps: z.number().int().optional() }),
  take_rate_bps: z.number().int(),           // Merited's cut of the bounty
  agent_commission_bps: z.number().int(),    // agent's cut of the bounty
  terms: z.object({
    attribution_window_s: z.number().int(),
    eligible_identity_tiers: z.array(z.enum(['T1','T2','T3'])),
    max_conversions: z.number().int().nullable(),
    clawback_window_s: z.number().int(),
    valid_from: z.string().datetime(), valid_until: z.string().datetime(),
  }),
  merchant_sig: z.string(), platform_sig: z.string(),
});

// Attribution Token claims (PASETO v4.public payload) — quote-bound (v1.1)
const AttributionTokenClaims = z.object({
  jti: Id('atk'), cid: Id('com'), qid: Id('qte'), aid: Id('agt'),
  tier: z.enum(['T1','T2','T3']), sid: z.string(),   // sha256(session_nonce)
  apr: Id('apr').nullable(),                         // approval ref — wallet path only
  iat: z.number().int(), exp: z.number().int(),
});

// Identity Link — OAuth-consented loyalty account (the T1 key)
const IdentityLink = z.object({
  link_id: Id('lnk'), consumer_ref: Id('usr'), merchant_id: Id('mer'),
  programme: z.string(),                              // e.g. 'aurora-club'
  member_ref: z.string(),                             // tokenised member id
  sub_hash: z.string(),                               // sha256(idp subject)
  scopes: z.array(z.enum(['profile','balance','tier'])),
  status: z.enum(['active','revoked']),
  linked_at: z.string().datetime(),
});
// NB: refresh tokens are NOT on this object — encrypted at rest in a separate
// wallet-backend table, never serialised into contracts or API responses.

// Offer Quote — the unit of response on the read path (v1.1)
const OfferQuote = z.object({
  quote_id: Id('qte'), offer_id: Id('off'), commitment_id: Id('com'),
  agent_id: Id('agt'), consumer_ref: Id('usr').nullable(),
  tier: z.enum(['T1','T2','T3']), segment: z.string(),   // categorisation output
  price: z.object({ list: Money, final: Money, mechanics_applied: z.array(z.string()) }),
  token: z.string().nullable(),                       // null for anonymous/unregistered reads
  expires_at: z.string().datetime(),                  // default now+15min, always ≤ token exp
});

// Approval — consumer authorisation of a specific quote (wallet path)
const Approval = z.object({
  approval_id: Id('apr'), mandate_id: Id('mnd'), quote_id: Id('qte'),
  mode: z.enum(['explicit','pre_authorised']),
  approved_at: z.string().datetime(), exp: z.string().datetime(),  // = quote.expires_at
  attestation: z.string(),                            // signed via Signer
});

// Conversion Claim (merchant → platform)
const ConversionClaim = z.object({
  claim_id: Id('clm'), merchant_id: Id('mer'),
  attribution_token: z.string(),
  order: z.object({ order_ref_hash: z.string(), gross_value: Money, ts: z.string().datetime() }),
  merchant_sig: z.string(),
});

// Mandate (consumer → agent authority)
const Mandate = z.object({
  mandate_id: Id('mnd'), consumer_ref: Id('usr'), agent_id: Id('agt'),
  scopes: z.array(z.enum(['offers:read','loyalty:read','checkout:execute'])),
  limits: z.object({ per_txn: Money, per_month: Money, categories: z.array(z.string()) }),
  merchants: z.array(z.string()),            // ids or '*'
  data_sharing: z.object({ email: z.boolean(), purchase_history: z.boolean(), loyalty_ids: z.boolean() }),
  status: z.enum(['active','revoked','expired']),
  exp: z.string().datetime(), attestation: z.string(),
});
```

**Event catalogue** (`packages/events`): `CommitmentCreated`, `QuoteIssued`, `TokenMinted`, `ApprovalGranted`, `ApprovalDeclined`, `ConversionClaimed`, `ConversionVerified`, `ConversionRejected {reason_code}`, `ConversionReversed`, `LedgerEntryPosted`, `SettlementNetted`, `MandateGranted`, `MandateRevoked`, `AccountLinked`, `AccountUnlinked`, `NotificationSent`, `OfferPublished`, `AgentRegistered`, `ErrandStateChanged` (Valet's own, wallet DB — mirrored to the ledger only from QUOTED onward). Every event row: `evt_id, seq (bigserial), type, body jsonb, prev_hash, this_hash = sha256(prev_hash ‖ canonical_json(body)), created_at`. Hash-chain verification function + a `verify-chain` CLI command are part of B2's acceptance.

**Rejection reason codes are first-class:** `SIG_INVALID`, `TOKEN_REPLAYED`, `WINDOW_EXPIRED`, `COMMITMENT_ENDED`, `CAP_EXHAUSTED`, `TIER_INELIGIBLE`, `BUDGET_EXHAUSTED`, `MANDATE_REVOKED`, `QUOTE_EXPIRED`, `APPROVAL_MISSING`, `APPROVAL_EXPIRED`, `LIMIT_EXCEEDED` (order value breaches mandate limits on an `apr`-bearing claim). Surface them in agent API responses and merchant analytics — both sides must see *why*.

---

## 4. The canonical read path (B9 — build this with the most care)

One internal function; every surface wraps it; **every response with a payable offer includes a minted token**.

```ts
async function readOffers(input: {
  agent: AgentCtx,                 // from verified agent auth
  consumer?: ConsumerCtx,          // optional: mandate ref, sub_hash/member ref, hashed email
  query: { merchant_id?: string; category?: string; sku?: string; text?: string },
}): Promise<OfferQuote[]>          // the unit of response IS the quote (v1.1)
```

Pipeline (each stage a pure module with its own tests):
`resolveIdentity(consumer) → filterEligibility(offers, tier, agent) → decisioning.rank(eligible, ctx) → guardrails.apply(ranked) → quote(final, ctx) → mintTokens(quotes, agent, tier)`

The **quote stage** resolves the final consumer price (mechanics applied against list price, member pricing at T1), assigns the categorisation `segment`, stamps `expires_at`, and persists the quote so the eventual claim can be audited back to the exact price and reasoning the agent was shown. Quotes are priced promises, not reservations — caps and budgets enforce at verification.

REST surface (Phase 0 unless marked):
```
POST /v1/agents/register                → { agent_id, api_key }
GET  /v1/offers?merchant_id&category…   → OfferQuote[] (auth: X-Merited-Agent-Key)
GET  /v1/offers/:id                     → single-offer quote (fresh token)
GET  /v1/quotes/:id                     → quote status (live | expired | converted)
POST /v1/quotes/:id/approve             → wallet-session auth → Approval + re-minted
                                          token with apr set                    [Ph 1]
POST /v1/claims                         → Grade-B conversion claim intake (merchant auth)
GET  /v1/claims/:id                     → claim status + verdict + reason_code

POST /v1/links/start                    → begin OAuth linking (wallet session)  [Ph 1]
GET  /v1/links/callback                 → code exchange → IdentityLink          [Ph 1]
POST /v1/links/:id/revoke               → immediate T1 downgrade                [Ph 1]
```

---

## 5. Module specs (Core)

### 5.1 Offers (B3)
Tables: `offers`, `offer_counters` (redeem counts — counters live *outside* the immutable COR). Control-plane CRUD; publishing a bounty-bearing offer calls the trio's commitment endpoint and stores the returned `commitment_id`. Editing a live bounty = end old commitment, create new one; the offer row points at the current COR, history preserved.
**Accept:** all 27 mechanics round-trip through Zod; publishing emits `OfferPublished` + `CommitmentCreated`; bounty edit produces a second COR and old tokens still verify against the first (test via simulator).

### 5.2 Agent Registry (B4)
Tables: `agents`, `agent_keys`. Phase 0: hashed API keys. Phase 1: Ed25519 request signing (verify via `Signer`). Rate limiting per agent via `RateLimiter`.
**Accept:** unregistered request to `/v1/offers` returns offers with `token: null` and a `register_to_earn` hint; registered request returns tokens.

### 5.3 Identity Resolution (B5)
Pure function `resolve(consumer?: ConsumerCtx) → { tier, identity_ref, segment }`. T1 = active **IdentityLink** matched via wallet consumer_ref or agent-supplied `sub_hash`/member ref (Ph 0: seeded Aurora Club table stands in for real links); T2 = hashed-email/pseudonymous match in `soft_identities`; T3 = default (acquisition segment). Segment assignment (the **categorisation** step) is deterministic in v1: tier × loyalty tier × new/returning → named segment consumed by decisioning.
**Accept:** property tests over precedence (link beats hash); revoked link or mandate downgrades immediately; same input → same segment (determinism).

### 5.4 Eligibility (B6)
Deterministic filters in fixed order: offer liveness → tier ∈ offer.identity_tiers → commitment liveness + cap (query trio/simulator) → stacking-group dedupe → merchant exclusion rules (Ph 1). Returns `(eligible[], excluded[{offer, reason}])`.
**Accept:** given a seeded fixture set, output is byte-identical across runs (determinism test).

### 5.5 Decisioning Slot (B7)
```ts
interface Decisioner { rank(eligible: EligibleOffer[], ctx: DecisionCtx): Promise<RankedOffer[]> }
```
v1 `RulesDecisioner`: merchant priority → margin-aware sort → tie-break stable by offer_id. The v2 ML sidecar later implements the same interface over HTTP. **Do not** put ML anywhere else in the codebase.
**Accept:** swapping `RulesDecisioner` for a `RandomDecisioner` in tests changes ranking only — no schema/API diffs.

### 5.6 Guardrails (B8)
Post-decision, deterministic: margin floor (offer cost ≤ configured ceiling), budget pacing (λ multiplier from remaining-budget/remaining-time; when λ < threshold, prefer points-denominated mechanics — points are the cheapest currency), brand rules (denylist categories/terms).
**Accept:** budget exhaustion flips reads to `no_offer` with `BUDGET_EXHAUSTED` visible in analytics within one event-projection cycle.

### 5.6a Quote Service (B24)
Tables: `quotes` (persisted OfferQuote + resolved inputs snapshot). Prices the final offer per consumer (mechanics application is a pure function over `OfferMechanics` — shared with the wallet UI for display parity), assigns segment, stamps expiry, requests token mint with `qid`. `GET /v1/quotes/:id` reports live/expired/converted (converted = a `ConversionVerified` referencing its `qid`).
**Accept:** every payable read persists exactly one quote per returned offer; token `qid` always resolves; expired quote + fresh claim → `QUOTE_EXPIRED` from verification (tested via simulator); price shown at quote time equals price in the verified claim's audit view.

### 5.7 Merchant Control Plane (B13)
Next.js internal admin: merchant CRUD + keypair issuance request (to trio), offer authoring against the mechanics union, commercial config (take-rate, commission split, budgets), claims/rejections viewer. Auth: single-team session (Clerk-style not needed; simple credential + TOTP is fine internally).

### 5.8 Adapters (B12 + interfaces)
`CommerceAdapter` contract: inbound normalised `OrderConfirmed {order_ref_hash, gross_value, token?, ts}` → build `ConversionClaim` → sign via `Signer` (custodied merchant key) → POST to trio. Grade-B implementation: a single authenticated webhook endpoint per merchant + this normalisation. `FakeShop`: tiny Fastify app with 5 seeded SKUs, a `/checkout` that accepts `{sku, attribution_token}`, emits the webhook. Valet v0 (B18) drives it; the storefront lives inside `apps/fake-aurora` (B27).

### 5.9 Analytics (B19)
Projections (Postgres tables rebuilt from the ledger): `conversions_by_agent_day`, `mint_vs_claim_by_merchant_day` (the under-reporting monitor), `rejections_by_reason_day`, `budget_burn`. Rebuildable from `seq = 0` — projections are disposable, the ledger isn't.
**Accept:** `pnpm analytics:rebuild` from a wiped projection schema reproduces identical tables.

---

## 6. Consent, wallet, account linking, and Valet

### 6.1 Consent & Mandate service (B14) — platform component
Endpoints: grant (consumer session) / attenuate (narrower child mandate referencing parent; **widening is a validation error by construction**) / revoke (immediate; emits `MandateRevoked`; eligibility and `checkout:execute` check live status, not cached). Mandate attestation signed via `Signer` (platform attests in Ph 1; consumer-held keys are out of scope). Mandates carry a `pre_authorised_up_to: Money` field — quotes at or below it skip explicit approval (an implicit Approval with `mode: 'pre_authorised'` is still recorded; nothing transacts without an approval object on the wallet path).
**Accept:** revocation mid-session causes Valet's next checkout attempt to fail with `MANDATE_REVOKED`; attenuated mandate cannot exceed any parent limit (property test); a quote above `pre_authorised_up_to` without explicit approval → `APPROVAL_MISSING`.

### 6.2 Wallet backend (B15)
Tables: `consumers`, `identity_links` (B23), `link_tokens` (encrypted refresh tokens — KMS data key via `Signer`-adjacent `Crypter` interface; `FakeCrypter` locally), `pd_store` (consented key-values), `errands` (Valet state), `push_subscriptions`, plus points read models. Magic-link auth via `Mailer`.

### 6.3 Account Linking service (B23)
OAuth 2.1 authorization-code + PKCE against `IdentityProviderAdapter`. Flow: `POST /v1/links/start` (returns authorize URL + state) → consumer authenticates at the brand IdP (FakeAurora locally) and consents scopes → `GET /v1/links/callback` exchanges the code, tokenises the member reference, writes the `IdentityLink`, emits `AccountLinked`. Revocation from either side (wallet button, or brand-initiated via IdP webhook/adapter poll) flips status and emits `AccountUnlinked`. Hosted-linking fallback for IdP-less programmes: member-number + verification-email loop producing the same `IdentityLink` — **never** credential capture.
**Accept:** full linking round-trip against FakeAurora in CI; revoked link → next quote resolves T2/T3 (live check, no cache window > 5s); refresh tokens never appear in any API response, log line, or contract type (lint rule + test); `sub_hash` matching from a *non-wallet* agent context resolves T1 (proves the walletless-T1 path).

### 6.4 Notifications & Approvals (B25/B26)
Web Push (VAPID keys, `web-push` lib) from the wallet backend. `NotificationSent` on push; payload = quote summary (offer title, final price, expiry countdown) + deep link to the approval screen. Approval endpoint issues the signed `Approval` and requests a **re-mint** of the attribution token with `apr` set (original token may have aged; the mint treats this as a fresh `jti` bound to the same `qid`). Declines emit `ApprovalDeclined` and expire the errand gracefully.
**Accept:** approve-then-execute within quote TTL verifies end-to-end; execute-without-approval on a wallet-path claim → `APPROVAL_MISSING`; approval after quote expiry → `APPROVAL_EXPIRED`; order value above mandate limit with valid approval → `LIMIT_EXCEEDED`.

### 6.5 Wallet UI — six screens (B16)
1. **Home / balances** — linked programmes, points, "merit" summary
2. **Linked accounts** — the OAuth linking flow made visible: link Aurora Club, see scopes granted, revoke (this screen is the *identity* story made visible)
3. **Valet mandate** — grant/attenuate/revoke with spend limits, category scopes, and the pre-authorisation threshold (this screen is the *consent* story made visible)
4. **Offers for you** — T1-personalised quote feed (live via Valet's registration)
5. **Valet errand** — brief → live state machine progress → notification → approve/decline → deal done, points credited
6. **Activity & settlement** — the consumer-visible tail of the ledger: what Valet did, the price it locked, what it earned, what was credited
Dark mode, green accent, per the Merited design brief — visually of a family with the roadmap/architecture artefacts.

### 6.6 Valet (B17 full / B18 v0)
One codebase in `apps/valet`, an **ordinary registered agent** (`agt_valet_*`) on public surfaces — no private imports from Core. The errand state machine (`BRIEFED → SEARCHING → QUOTED → AWAITING_APPROVAL → APPROVED → EXECUTING → CONFIRMED | FAILED | DECLINED | EXPIRED`) is the stable skeleton across both phases:

- **B18 · Valet v0 (Phase 0, walletless):** CLI-driven brief → REST quote path (T3 or seeded-T1 via `sub_hash`) → approval states auto-skipped (no mandate) → checkout against FakeShop carrying the token → poll verdict → print settlement lines. This *is* Act 1 of the demo.
- **B17 · Valet full (Phase 2, wallet-driven):** briefs from wallet UI, mandate in context, notification/approval loop live, optional LLM brief-interpreter (Anthropic API) for natural-language errands with a scripted fallback flag (`VALET_DETERMINISTIC=1`) so the recorded demo never depends on model nondeterminism. Checkout rails: FakeShop/Grade-B (Ph 2), Shopify + UCP/ACP protocol checkouts (Ph 3).
**Accept:** the state machine is a pure reducer with exhaustive transition tests; every transition from QUOTED onward emits `ErrandStateChanged` mirrored to the ledger; killing and restarting Valet mid-errand resumes from persisted state (durability test).

---

## 7. ★ The trio — contracts, simulators, and the senior-dev boundary

**Claude Code builds:** the HTTP contracts below, Zod schemas, OpenAPI docs, the three **simulators**, and exhaustive contract tests. **Claude Code must not implement:** real PASETO minting/verification, Ed25519/KMS operations, replay-store hardening, or double-entry posting logic destined for production. Simulators live in `apps/trio/*/simulator.ts` and are replaced file-for-file by the senior dev.

### 7.1 Commitment Signing — `POST /trio/commitments`
In: unsigned commitment draft. Out: COR with `merchant_sig` + `platform_sig`. Also `POST /trio/commitments/:id/end`. Simulator: fake sigs (`fake-ed25519:<hmac>`), immutability enforced, emits `CommitmentCreated`.

### 7.2 Token Mint + Conversion Verification — `POST /trio/tokens/mint`, `POST /trio/claims/verify`
Mint in: `{cid, qid, aid, tier, session_nonce, apr?}` → out: token string (re-mint for approval = same `qid`, fresh `jti`, `apr` set). Verify in: `ConversionClaim` → out: `{verdict: 'verified'|'rejected', reason_code?, entries_preview}` and emits `ConversionVerified|Rejected`. Verification checks, in order: signature chain → replay → window → **quote liveness (`QUOTE_EXPIRED`)** → commitment terms → **approval checks when `apr` is present** (approval exists, unexpired, quote-matched; order value within mandate limits → else `APPROVAL_*`/`LIMIT_EXCEEDED`). Walletless claims (`apr: null`) skip approval checks by design. Simulator: base64 JSON pseudo-tokens, real replay logic (Postgres unique on `jti` — build this properly, it's not crypto), real window/quote/terms/approval checks, fake signature checks.

### 7.3 Net Settlement — `POST /trio/entries` (internal, from verification), `POST /trio/claims/reverse`, `GET /trio/positions/:party`, `POST /trio/netting/run`
Simulator: real arithmetic (this is worth building faithfully — it's accounting, not crypto): balanced double-entry sets per `ConversionVerified` (`merchant_payable` / `agent_receivable` / `platform_revenue` / `reserve`), clawback reversals within window, netting run folds to net positions and emits `SettlementNetted`, statement generation (`GET /trio/statements/:party/:period` → JSON + rendered PDF via the existing Playwright/Chromium path).
**Accept (all three):** the contract test suite passes against the simulator; the same suite is the senior dev's acceptance gate against the real implementation. Trial balance sums to zero after any generated sequence of verify/reverse/net operations (property test).

---

## 8. Cross-cutting build requirements

- **Tracing:** one trace ID from `readOffers` → mint → checkout webhook → verify → ledger entries. `tools/demo` prints the trace URL. This trace is the recorded demo's backbone.
- **Idempotency:** claim intake and webhook endpoints accept an `Idempotency-Key`; replays return the original result.
- **Migrations:** Drizzle migrations, forward-only; ledger tables get `REVOKE UPDATE, DELETE` at the DB role level (append-only enforced in Postgres, not just in code).
- **Config:** typed env loader in `packages/contracts`; fail fast on missing vars.
- **Testing bar:** every module ships unit tests; the repo ships one end-to-end test that is literally the demo script in CI against simulators + FakeShop.
- **Security hygiene (non-trio):** no secrets in code, parameterised SQL only, authn on every route, per-agent and per-merchant rate limits, webhook signature verification even in dev.

---

## 9. Phase gates

| Phase | Ships | Gate (all must pass) |
|---|---|---|
| **0 — Acquirable proof point** (Q3 26) | B1–B5 core, B6 minimal, B9, B12, B13 thin, **B18 (Valet v0), B24 (quotes)**, B20, B21, B22, B27 (FakeShop storefront) | `pnpm demo:act1` runs the **walletless** loop on a clean machine: offer published with signed CPA bounty → Valet v0 reads → **quote issued, quote-bound token minted** → FakeShop checkout → claim → **verified** → balanced ledger entries → statement preview. Chain verifies via `verify-chain`. Recorded as the demo asset. |
| **1 — Harden & first partners** (Q4 26) | B6 full, B7, B10, B14, B15, B19, **B23 (linking + FakeAurora IdP), B25 (push), B26 (approvals)**; senior-dev trio implementations land; real design-partner webhook live | Contract suite green against **real** trio; mint-vs-claim monitor live; MCP server passes inspector; mandate + approval property tests green; **OAuth linking round-trip in CI; walletless-T1 via `sub_hash` proven**. |
| **2 — Optimiser & scale** (Q1 27) | B8 full, B16 (six screens), B17 (Valet full), merchant dashboard UI, Stripe Connect payouts, ML sidecar slot-in | **`pnpm demo:act2` — the wallet act — end-to-end on real rails:** link Aurora Club → brief Valet → notification → approve → transact → points credited on the activity screen; netting run produces a real Connect transfer in test mode; swapping decisioners requires zero API changes (proved in CI). |
| **3 — Interop & exit-ready** (Q2 27) | B11, UCP/ACP adapters, Shopify app (Grade A), self-serve onboarding, open verification spec + reference verifier | Third party can verify a conversion from published head-hashes + a COR without Merited access; anonymous JSON-LD reads are untokenised; a new merchant self-onboards without manual steps. |

---

## 10. The demo (`tools/demo`) — two acts, one set of rails

The demo is the asset that closes a design partner and a pre-seed. It is deliberately **two acts on identical rails**: Act 1 proves the B2B platform stands alone; Act 2 proves the consumer product vision on top of it. The closing line of both: *the token architecture is identical — the only differences are who the agent is and how much Merited knows.*

### Act 1 — walletless (`pnpm demo:act1`, ships Phase 0)
1. Seed merchant **Aurora Experiences** + Aurora Club members + 6 offers, one with a **£12.00 fixed CPA bounty** (20% take-rate, 60% agent commission).
2. Publish → COR created and countersigned → print commitment JSON + signatures.
3. **Valet v0** registers as an ordinary agent → briefs itself ("spa day under £120") → quote path returns an **OfferQuote**: T3 acquisition offer, final price, expiry, **quote-bound attribution token** (print quote + token claims, `apr: null`).
4. Valet checks out on the Aurora FakeShop storefront carrying the token (order £84.50).
5. Webhook → Grade-B adapter → signed Conversion Claim → verification prints each check passing (sig chain ✓ replay ✓ window ✓ quote ✓ terms ✓).
6. Ledger posts: merchant −£12.00 · agent +£7.20 · Merited +£2.40 · reserve £2.40 — trial balance zero.
7. Netting preview + statement PDF.
8. Replay the same token → **rejected `TOKEN_REPLAYED`**; submit against an expired quote → **rejected `QUOTE_EXPIRED`** (prove the negative cases on camera).
9. Print the single end-to-end trace URL and the verified hash-chain head.

### Act 2 — the wallet loop (`pnpm demo:act2`, ships Phase 2)
1. Consumer opens the wallet → **links Aurora Club** via the FakeAurora OIDC consent screen (show scopes) → `IdentityLink` created.
2. Grants Valet a **mandate**: £150/txn, experiences category, pre-authorised to £50.
3. Briefs Valet: "book me a spa day under £120." Errand state machine on screen.
4. Quote path recognises the consumer (**T1 via the link**), categorises (Gold-tier member segment), returns the **member price** and offer — visibly different from Act 1's T3 quote for the same query (print both side by side).
5. £84.50 > £50 pre-auth threshold → **wallet push notification** → consumer opens approval screen → approves → signed Approval, token re-minted with `apr` set.
6. Valet executes checkout; claim verifies with the **approval checks passing** (approval ✓ mandate limits ✓); settlement splits; **Aurora Club points credit** via the loyalty adapter.
7. Activity screen shows the consumer-visible ledger tail: what Valet did, the locked price, points credited.
8. Negative cases on camera: revoke the mandate mid-errand → `MANDATE_REVOKED`; decline a notification → errand ends `DECLINED`, nothing charged, nothing settled.
9. Same trace URL treatment — one trace from brief to ledger.

---

## 11. Non-goals (do not build, even if it seems easy)

Real payment processing or card storage · consumer payment auth (Stripe Link territory, later/never) · loyalty aggregation across programmes (Ph 3+) · the full ML engine before Phase 2 · multi-region/tenant-isolated infra · blockchain anything · a public self-serve merchant signup before Phase 3 · native mobile apps.

---

*End of build spec v1.0. When a decision here conflicts with convenience, the spec wins; when the spec is silent, `merited-platform-architecture.md` §0's five principles decide.*
