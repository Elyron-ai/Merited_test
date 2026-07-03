# Merited.ai — Platform Architecture

**Version:** 1.1 · July 2026
**Status:** Proposed — canonical architecture reference for the Claude Code build
**Scope:** Business Engine (agentic loyalty offers platform), Consumer Data/Loyalty Wallet with OAuth-linked loyalty accounts, **Valet** (the first-party commerce agent — working name, pending clearance), Merchant Clearing & Attribution Backend, and the recognition → quote → approve → transact loop that binds them — demonstrable both with and without the consumer wallet.

> **v1.1 changes:** Valet named and specified as a product component (§4.3); Account Linking service for OAuth-consented loyalty identity (§4.4); Quote semantics added to the read path with quote-bound attribution tokens (§2.3, §3.2); notifications & approvals in the token chain (§4.5); the end-to-end loop with the walletless variant (§4.6). Fictional demo brand: **Aurora Experiences** / **Aurora Club** loyalty programme.

---

## 0. Architectural principles

These five principles resolve most downstream decisions. When a design question arises, test it against these before anything else.

**P1 — The ledger is the product.** Committed CPA clearing and deterministic attribution are the moat. Everything else (offers surfacing, ML decisioning, the wallet) is a client of, or a feeder into, the attribution/clearing spine. The spine ships first and nothing bypasses it.

**P2 — No token, no bounty.** Every distribution channel — MCP server, REST API, JSON-LD feed, UCP/ACP adapters — is a façade over one Offer Read API, and every offer read mints a signed Attribution Token. Attribution is structurally unavoidable, not opt-in. This is the single most important invariant in the system.

**P3 — Small blast radius for the security-critical trio.** Commitment Signing, Conversion Verification, and Net Settlement are isolated services with their own keys, their own datastore schemas, and a minimal, signed interface to the rest of the platform. The senior dev owns this boundary; Claude Code builds everything outside it. The trio never trusts input from the monolith without verifying signatures.

**P4 — Deterministic core, pluggable intelligence.** Eligibility and attribution are deterministic and auditable. The ML uplift engine (v2) plugs into a stable Decisioning interface behind the deterministic layer — swapping rules-ranking for uplift/bandit decisioning changes zero API contracts.

**P5 — The wallet is a client, not a privileged component.** The consumer wallet and Valet, its agent, consume the same public agent-facing APIs as any third-party agent. It gets no backdoor. This dogfoods the platform, keeps the demo honest for sales engineering, and means the wallet can later become a real product without re-architecture.

---

## 1. System topology

**Shape: modular monolith + three isolated security services + append-only event ledger.**

Given the constraints — one primary builder with Claude Code, ~4 weeks of senior dev time, £65k annual budget — microservices sprawl would be fatal. The correct topology is a single deployable application ("Merited Core") with strict internal module boundaries, plus the three security-critical engines deployed as separate services because their trust requirements genuinely differ, not for scaling theatre.

```
                        ┌─────────────────────────────────────────────┐
                        │              AGENT SURFACES                 │
                        │  MCP Server │ REST API │ JSON-LD Feed       │
                        │  UCP Adapter │ ACP Adapter                  │
                        └──────────────────┬──────────────────────────┘
                                           │  (all reads funnel here)
┌───────────────┐       ┌──────────────────▼──────────────────────────┐
│ CONSUMER      │       │              MERITED CORE (monolith)        │
│ WALLET        │──────▶│                                             │
│  · wallet API │       │  Offer Service      Identity Resolution     │
│  · linked     │       │  Quote Service      Account Linking (OAuth) │
│    accounts   │◀─OAuth│  Eligibility Engine Merchant Control Plane  │
│    (OAuth)    │  IdP  │  Decisioning Slot   Integration Adapters    │
│  · consent /  │       │  Token Mint ◀────── Analytics / Read Models │
│    mandates   │       └───────┬──────────────────────┬──────────────┘
│  · notify /   │               │                      │
│    approve    │               │                      │
│  · VALET      │               │                      │
│    (agent)    │               │                      │
└───────────────┘               │ signed events        │ signed requests
                        ┌───────▼──────────────────────▼──────────────┐
                        │        SECURITY-CRITICAL TRIO (★)           │
                        │                                             │
                        │  Commitment      Conversion     Net         │
                        │  Signing Svc     Verification   Settlement  │
                        │                  Svc            Svc         │
                        └───────┬─────────────────────────────────────┘
                                │ append-only, hash-chained
                        ┌───────▼─────────────────────────────────────┐
                        │        EVENT LEDGER (Postgres, WORM-style)  │
                        │  CommitmentCreated · TokenMinted ·          │
                        │  ConversionClaimed · ConversionVerified ·   │
                        │  LedgerEntryPosted · SettlementNetted       │
                        └───────┬─────────────────────────────────────┘
                                │
                        ┌───────▼─────────────────────────────────────┐
                        │  MERCHANT SIDE                              │
                        │  Conversion webhook / plugin (Shopify etc.) │
                        │  Merchant signing key · order confirmation  │
                        └─────────────────────────────────────────────┘
```

**Why not one process for everything?** The trio holds signing keys and money-adjacent state. Isolating it means a compromise of the (large, fast-moving, Claude-Code-built) monolith cannot forge commitments, fake conversions, or move ledger balances — the trio verifies signatures on everything it receives, including from the Core.

**Why not more services?** Every additional service costs deployment, observability, and inter-service auth overhead the team can't afford. The monolith's internal modules communicate through in-process interfaces with the same contracts they'd have as services, so any module can be extracted later if scale demands it.

---

## 2. The attribution & clearing spine (the moat)

This section is the crown jewel and the senior-dev scope. The mechanism must be *deterministic* (no probabilistic matching), *cookieless* (no browser state), and *cryptographically verifiable end-to-end* (Phase 3: third parties can check the proof).

### 2.1 The chain of custody

Attribution is a chain of four signed artefacts. Break any link and the conversion doesn't clear — which is the point.

```
1. COMMITMENT          2. ATTRIBUTION TOKEN      3. CONVERSION CLAIM      4. VERIFIED CONVERSION
   merchant signs         platform mints on         merchant returns          verification svc
   CPA bounty terms;      every offer read;         token with signed         validates all three
   platform counter-      binds agent+offer+        order confirmation        signatures + replay
   signs                  session                                             + window + terms
   ────────────────▶      ────────────────▶         ────────────────▶         ────────────────▶
   immutable record       short-lived, single       webhook / plugin          ledger entries
   in ledger              purpose                   posts to platform         posted
```

### 2.2 Commitment Signing Service ★

A merchant publishing an offer with a CPA bounty produces a **Committed Offer Record (COR)**:

```json
{
  "commitment_id": "com_01J...",
  "merchant_id": "mer_...",
  "offer_ref": "off_...",
  "bounty": { "type": "fixed", "amount": 1200, "currency": "GBP_pence" },
  "take_rate_bps": 2000,
  "agent_commission_bps": 6000,
  "terms": {
    "attribution_window_s": 86400,
    "eligible_identity_tiers": ["T1","T2","T3"],
    "max_conversions": 500,
    "valid_from": "...", "valid_until": "..."
  },
  "merchant_sig": "ed25519:...",
  "platform_sig": "ed25519:..."
}
```

Design decisions:
- **Ed25519 signatures, merchant keypair issued at onboarding.** For Phase 0/1 the merchant's private key is custodied by Merited in KMS (merchants won't run key infrastructure to try a pilot); the API design assumes merchant-held keys so custody can be handed over later without contract changes. Custodied-but-separated is honest for a pilot; the *architecture* is trustless even where the Phase 0 *deployment* isn't.
- **The COR is the unit of commercial truth.** Offers can be edited freely in the control plane, but a bounty change creates a *new* commitment; old tokens verify against the commitment they were minted under. No retroactive repricing — this is what "committed" means and what UIP doesn't have.
- **Counters (max_conversions, budget) live in the Settlement service**, not the COR, so the COR stays immutable.

### 2.3 Token Mint (in Core, keys held by Verification service)

On **every** offer read through **any** surface, the Core requests a token from the Verification service's minting endpoint:

```
AttributionToken (PASETO v4.public, ~10 min – attribution_window TTL):
{
  "jti":  "atk_01J...",          // unique, replay-checked
  "cid":  "com_01J...",          // commitment being claimed against
  "qid":  "qte_01J...",          // the quote this token was minted for (v1.1)
  "aid":  "agt_...",             // verified agent identity
  "tier": "T2",                  // identity tier at read time
  "sid":  "hash(session_nonce)", // agent session binding
  "apr":  "apr_... | null",      // approval ref — wallet path only (v1.1)
  "iat":  ..., "exp": ...
}
```

**Quote binding (v1.1).** Tokens are minted *for a quote* — a priced, expiring answer to "what will this offer cost this consumer, via this agent, right now." The `qid` claim ties the eventual conversion back through the exact price and categorisation the agent was shown, which makes the end-to-end story auditable at the *decision* level, not just the transaction level: commitment → quote → (approval) → conversion → settlement, one chain. The optional `apr` claim carries the consumer-approval reference on the wallet path; on the walletless path it is null and consumer consent is the calling agent's own responsibility.

- **PASETO over JWT** to eliminate algorithm-confusion foot-guns; the senior dev should not have to defend against `alg:none`.
- The agent carries this token through to checkout and includes it in the order (Shopify: cart attribute / note; headless: order metadata field; API checkout: request field). No cookies, no fingerprinting, no probabilistic matching — the token *is* the attribution.
- **Verified Agent Token** (agent identity) is a prerequisite: agents register once, get an `aid` + API key (Phase 0) upgrading to key-signed requests (Phase 1). Anonymous reads can be allowed on the JSON-LD feed but mint no token — visible but not payable, which is itself an adoption incentive to register.

### 2.4 Conversion Verification Service ★

The merchant-side integration (Shopify app, Salesforce/commerce adapter, or a plain webhook from the merchant's order system) posts a **Conversion Claim** on order confirmation:

```json
{
  "claim_id": "clm_...",
  "merchant_id": "mer_...",
  "attribution_token": "<paseto>",
  "order": { "order_ref_hash": "sha256:...", "gross_value": 8450, "currency": "GBP_pence", "ts": "..." },
  "merchant_sig": "ed25519:..."
}
```

Verification pipeline (fully deterministic, every step emits a ledger event):

1. **Signature chain** — merchant sig on claim → platform sig on token → merchant+platform sigs on the referenced COR.
2. **Replay** — `jti` single-use (Postgres unique constraint as source of truth; Redis as a fast-path cache in front, never authoritative).
3. **Window** — claim `ts` within `iat + attribution_window`.
4. **Terms** — commitment still live, conversion counter not exhausted, tier eligible, budget available (checked against Settlement).
5. **Emit** — `ConversionVerified` (or `ConversionRejected` with a machine-readable reason — rejections are first-class data; merchants and agents both need to see *why*).

Order values are carried as hashes + amounts, not full order payloads — the platform needs the money numbers and proof of the order's existence, not the basket contents (data-minimisation, and merchants will ask).

### 2.5 Net Settlement Service ★

A **double-entry, event-sourced ledger**. Every `ConversionVerified` posts a balanced entry set:

```
Dr merchant_payable[mer_X]         £12.00   (bounty owed by merchant)
Cr agent_receivable[agt_Y]          £7.20   (60% commission)
Cr platform_revenue                 £2.40   (20% take-rate)
Cr merchant_rebate/reserve          £2.40   (remainder per commercial config)
```

- **Accounts:** one per party per currency (`merchant_payable`, `agent_receivable`, `platform_revenue`, plus `reserve` accounts for clawback/refund handling).
- **Netting:** a periodic (weekly, Phase 1) netting run folds all entries per counterparty into a single net position → `SettlementNetted` event → payout instruction. Phase 1: simulated payouts (statements, no money moves). Phase 2/3: Stripe Connect for real disbursement — Connect handles KYC/KYB, multi-party transfers, and keeps Merited out of money-transmitter licensing for as long as possible. **Flag for counsel:** the moment Merited touches funds directly, UK PSR/EMI questions arise; Stripe Connect's merchant-of-record-adjacent model is the deliberate dodge.
- **Refunds/clawbacks:** merchant posts a signed `ConversionReversed` claim within a configured clawback window; the ledger posts reversing entries against the reserve account. Never edit history — only append reversals.

### 2.6 The audit trail & third-party verification (Phase 3 hook)

Every event in the spine is appended to a **hash-chained log**: each event stores `sha256(prev_hash ‖ event_body)`. Periodically (daily), the head hash is published externally (simplest credible option: a public S3 object + posted to the merchant's own systems; blockchain anchoring is unnecessary theatre for now). This makes the ledger tamper-evident and gives Phase 3's "attribution as open spec / independently checkable proof" a concrete foundation: a third party holding the published heads and a merchant's CORs can verify any conversion claim without trusting Merited.

---

## 3. The Business Engine (agentic loyalty offers platform)

Everything merchants touch. Lives in the Core monolith.

### 3.1 Merchant Control Plane

- **Onboarding:** merchant record, keypair issuance, integration adapter selection, commercial config (take-rate, commission split, settlement cadence). Phase 0 is hand-onboarding — the control plane can be thin (internal admin UI) until Phase 3's self-serve.
- **Offer authoring:** the 27 offer types expressed as a single canonical `Offer` schema with a `mechanics` discriminated union (percentage-off, fixed-off, points-multiplier, tier-unlock, bundle, welcome-bonus, …). One table, one schema, typed variants — do not build 27 tables.
- **Budget & pacing config:** period budgets, margin floors, objective weights. Consumed by the Decisioning Slot; enforced as hard guardrails in Eligibility.

### 3.2 Offer Service & the canonical read path

One internal function — `readOffers(agent_ctx, consumer_ctx, query) → [OfferQuote]` — that every surface calls. **The unit of response is a Quote (v1.1)**: the offer, the *resolved price for this consumer* (list price, mechanics applied, final price), the live bounty terms from the COR, a quote expiry (default 15 min, always ≤ token TTL), and the quote-bound attribution token. A quote is a priced promise, not a reservation — commitment caps and budgets are enforced at verification, so no inventory-hold complexity enters the system. Surfaces:

- **MCP server** (Phase 1): tools like `search_offers`, `get_offer`, `check_eligibility` — thin wrappers.
- **REST API** (Phase 0): for Valet v0 and early partners.
- **JSON-LD feed** (Phase 3): `schema.org/Offer`-based static feed for aggregators; registered agents fetch personalised/tokenised variants, anonymous fetchers get untokenised (unpayable) offers.
- **UCP/ACP adapters** (Phase 3): conformance translators mapping Merited offers into the protocol schemas — and mapping protocol checkout callbacks back into Conversion Claims. This is where you interoperate with the standards without letting them own attribution.

### 3.3 Identity Resolution (3 tiers)

- **T1 (known):** an active **Identity Link** exists — the consumer has OAuth-consented a loyalty account (§4.4) — or a mandate-bearing wallet context resolves to one → personalised eligibility, loyalty recognition, member pricing.
- **T2 (soft-match):** hashed email / stable pseudonymous ID from the agent → segment-level eligibility.
- **T3 (unknown):** treated as an acquisition segment — welcome bonuses, first-purchase incentives.

Resolution is a pure function producing a `tier + identity_ref + segment` that flows into eligibility, decisioning (**categorisation** — the consumer is assigned to a segment that steers which offer and price come back), and the Attribution Token. Loyalty recognition (Eagle Eye or merchant-native programme lookup) is an adapter behind this module — Phase 0 keeps it minimal (a seeded Aurora Club membership table), with real OAuth linking arriving with the Account Linking service.

### 3.4 Eligibility Engine → Decisioning Slot → Guardrails

The six-stage pipeline from the offers-engine design maps onto three modules with hard interfaces:

```
readOffers()
  → Eligibility (deterministic filter: tiers, consent, exclusions, stacking rules,
                 commitment liveness, budget-available check)
  → Decisioning  (interface: rank(eligible_offers, ctx) → chosen offer(s) or none)
       v1: rules ranking (merchant priority, margin-aware sort)
       v2: uplift/propensity models + Thompson-sampling bandit  ← drop-in, same interface
  → Guardrails   (margin floor, budget pacing λ, brand rules — deterministic, post-decision)
```

The v2 ML engine (propensity, uplift, elasticity, CLV, contextual bandit — LightGBM/XGBoost per the design session) deploys as a sidecar model service called by the Decisioning module, trained offline on the event ledger. **Nothing about v1's API changes when v2 arrives** — that's the entire point of the slot. Feature assembly reads from ledger-derived read models, so the moat's data exhaust is literally the ML engine's training set: another reason the spine ships first.

### 3.5 Analytics & read models

Event-ledger projections into Postgres read models: agent-vs-human traffic, conversion funnels by agent/offer/tier, budget burn, rejection reasons. Phase 2's merchant dashboard is a UI over these projections — no new data collection needed because the spine already emits everything.

---

## 4. The Consumer Data / Loyalty Wallet, Account Linking, and Valet

Scoped as a **six-screen sales-engineering demo** (M4–M5), but architected as a real client so it can graduate without rework. Three genuinely load-bearing pieces sit *behind* the demo UI and belong to the platform proper: the Mandate service (§4.1), the Account Linking service (§4.4), and Valet itself (§4.3).

### 4.1 Consent & Mandate Service (platform component, not demo scaffolding)

The consumer's grant of authority to an agent is a first-class signed object — the consumer-side mirror of the merchant's COR:

```json
{
  "mandate_id": "mnd_...",
  "consumer_ref": "usr_... (pseudonymous)",
  "agent_id": "agt_valet_...",
  "scopes": ["offers:read", "loyalty:read", "checkout:execute"],
  "limits": { "per_txn": 25000, "per_month": 150000, "categories": ["travel","experiences"] },
  "merchants": ["mer_virgin_exp", "*"],
  "data_sharing": { "email": false, "purchase_history": false, "loyalty_ids": true },
  "revocable": true, "exp": "...",
  "consumer_sig_or_platform_attest": "..."
}
```

- **Attenuation, never escalation:** a mandate can be narrowed (per-session caveats — "this trip only, max £180") but an agent can never widen its own authority. Macaroon-style thinking even if implemented as plain signed tokens with caveat fields.
- **Revocation is immediate:** mandates are checked live (not just at token mint) before `checkout:execute`.
- Mandate references travel inside the consumer_ctx at offer read, which is what upgrades identity resolution to T1 and unlocks the consented 1pd — **the one input merchant-side Talon.One structurally cannot have.** This service is small, but strategically it is the wallet's whole reason to exist in the B2B story.

### 4.2 Wallet backend (demo-real)

Consumer profile, linked loyalty memberships (Phase 0: manual/static links; aggregation is Phase 3), a consented 1pd preference store, and the points/gamification read models for the demo screens (balances, points-hacking suggestions). Thin CRUD over Postgres — Claude Code territory entirely.

### 4.3 Valet — the first-party commerce agent (v1.1)

**Valet** (working name — clearance pending; rejected alternatives: Envoy collides with Envoy Proxy for a developer audience, Fetch collides in loyalty) is Merited's own end-to-end commerce agent. Consumer framing: *"your valet earned you the deal."* Architecturally it is **an ordinary registered agent** (`agt_valet_*`) on the public surfaces — no privileged access (P5) — but as a *product* it is a full transact-capable agent, not a reference script.

Valet runs **errands**: durable jobs with a small explicit state machine —

```
BRIEFED → SEARCHING → QUOTED → AWAITING_APPROVAL → APPROVED → EXECUTING
                                     │                            │
                                     ├→ DECLINED / EXPIRED        ├→ CONFIRMED (claim verified)
                                     └→ (pre-authorised: skip)    └→ FAILED (retryable)
```

- **BRIEFED:** consumer states the errand in the wallet ("book me a spa day under £120"). The brief + the mandate define Valet's authority envelope.
- **SEARCHING → QUOTED:** Valet calls the quote path over MCP/REST with the mandate in `consumer_ctx` → Merited recognises (T1 via Identity Link), categorises, and returns an **OfferQuote** — offer, member price, quote expiry, quote-bound token.
- **AWAITING_APPROVAL:** Valet pushes a wallet notification (§4.5). If the quote sits *within* the mandate's limits and the mandate is flagged pre-authorised, this state is skipped and an implicit Approval is recorded; otherwise the consumer explicitly approves or declines before the quote expires.
- **EXECUTING:** Valet performs checkout at the merchant via the appropriate rail — Grade-B sandbox checkout in the demo; Shopify checkout, and UCP/ACP protocol checkouts as those adapters land in Phase 3 — carrying the attribution token (with `apr` set) into the order.
- **CONFIRMED:** the merchant's Conversion Claim verifies; the wallet's activity screen shows the ledger tail — deal done, points credited, what Valet earned.

Errand state is Valet's own (a table in the wallet backend); the platform never depends on it. For the **Phase 0 demo**, Valet v0 is a deterministic script wearing the product's name — the rails are what's being proven. The LLM-driven brief interpreter and protocol checkouts are Phase 2–3 flesh on the same skeleton.

### 4.4 Account Linking — OAuth-consented loyalty identity (v1.1)

The wallet "holds the auth": consumers link their brand loyalty accounts so Merited can recognise them on the brand's behalf. The demo brand is **Aurora Experiences**, whose **Aurora Club** programme (Member / Gold tiers) runs a standard OIDC identity provider.

```
Wallet "Link Aurora Club" → OAuth 2.1 authorization-code + PKCE against the
brand IdP → consumer authenticates & consents scopes (profile, balance, tier)
→ Merited receives code, exchanges for tokens → creates IDENTITY LINK:

{ link_id: "lnk_...", consumer_ref: "usr_...", merchant_id: "mer_aurora",
  programme: "aurora-club", member_ref: "<tokenised member id>",
  scopes: ["profile","balance","tier"], sub_hash: "sha256(idp_sub)",
  status: "active" }
```

Design decisions:
- **Merited is the OAuth client, acting on behalf of the brand.** Brands with a real IdP (or CIAM like Auth0/Cognito) just register Merited as a client. Brands *without* one get **hosted linking** — Merited runs the link flow against the merchant's loyalty API using whatever credential the programme supports (login, member-number + verification email). Same Identity Link record either way; the adapter absorbs the mess.
- **The Identity Link is the T1 key.** `resolveIdentity` matches wallet consumer_ctx (or an agent-supplied `sub_hash`) to an active link → T1, member tier, member pricing. Revoking the link (wallet or brand side) downgrades recognition immediately — same live-check discipline as mandates.
- **Refresh tokens encrypted at rest** (KMS data key), stored in the wallet backend, never exposed to agents. Agents get *recognition outcomes* (tier, eligibility), never credentials — data minimisation is what makes brands comfortable federating identity through Merited at all.
- **Non-wallet T1 is possible:** a third-party agent whose platform has its own account linkage can present a `sub_hash`/member reference; if it matches a consented link, T1 applies. The wallet is the *first* linking surface, not the only one.

### 4.5 Notifications & approvals (v1.1)

Web Push (VAPID) from the wallet backend — first-party, no vendor. A notification carries the quote summary (offer, price, expiry) and deep-links to an approve/decline screen. Approval produces a signed **Approval record**:

```
{ approval_id: "apr_...", mandate_id: "mnd_...", quote_id: "qte_...",
  mode: "explicit" | "pre_authorised", approved_at, exp = quote.expires_at }
```

The `apr` reference is minted into the attribution token (re-mint on approval if the original token expired), so consumer authorisation is part of the same verifiable chain as attribution. Approvals are single-use and quote-bound — a fresh quote needs a fresh approval unless the mandate pre-authorises it.

### 4.6 The end-to-end loop — with and without the wallet (v1.1)

The same rails, two entry paths. **This dual-path is a deliberate demo requirement:** the wallet path shows the full consumer product vision; the walletless path proves the B2B platform stands alone.

```
WALLET PATH (T1)                            WALLETLESS PATH (T2/T3)
────────────────                            ───────────────────────
Consumer briefs Valet in wallet             Any third-party agent (ChatGPT/Claude/
        │                                   vertical agent) queries via MCP/REST
        ▼                                           │
Valet → quote request (mandate ctx)                 ▼
        │                                   Quote request (hashed email → T2,
        ▼                                   or nothing → T3)
Merited: Identity Link → T1 →                       │
categorise → member offer + price                   ▼
        │                                   Merited: T2 segment / T3 acquisition →
        ▼                                   categorise → generic/welcome offer + price
OfferQuote + token (qid, apr pending)               │
        │                                           ▼
        ▼                                   OfferQuote + token (qid, apr = null)
Wallet notification → consumer                      │
approves (or mandate pre-auths)                     ▼
        │                                   Agent's own UX handles consent;
        ▼                                   agent executes checkout w/ token
Valet executes checkout w/ token                    │
        │                                           │
        └────────────────┬──────────────────────────┘
                         ▼
        Merchant Conversion Claim (token inside)
                         ▼
        Verification: sig chain ✓ replay ✓ window ✓ terms ✓
        [wallet path additionally: approval ✓ mandate limits ✓]
                         ▼
        Settlement: merchant / Merited / agent split
        [wallet path: activity screen shows the ledger tail;
         Aurora Club points credit via the loyalty adapter]
```

The only differences between the paths are *who the agent is* and *how much Merited knows* — the token architecture, verification pipeline, and settlement are identical. That is the sentence to say on camera.

### 4.7 What the wallet must NOT do

No direct DB access to Core. No unsigned shortcuts into settlement. No payment credential storage in Phase 0/1 (sandbox checkout only; real payment auth is a Stripe Link/issuer-tokenisation integration question for much later, and probably never Merited's job — see the Part-2 analysis on wallets: the payment rails belong to Stripe/Visa, Merited's wallet differentiation is loyalty + consented data + mandates).

---

## 5. Merchant-side integration architecture

The clearing backend only works if conversions reliably flow back. Three integration grades, all producing the same signed Conversion Claim:

| Grade | Mechanism | Phase | Effort for merchant |
|---|---|---|---|
| **A — Platform plugin** | Shopify app: injects token capture at checkout (cart attribute), listens to `orders/paid`, posts signed claim | 1–2 | Install + approve |
| **B — Webhook adapter** | Merchant's order system posts order-confirmed webhook to Merited adapter; adapter builds + signs the claim (custodied key) | 0–1 | One webhook |
| **C — Batch reconciliation** | Signed daily order-file upload (SFTP/API), matched on token refs | 2 | Reporting export |

Phase 0 with the design partner is Grade B — one webhook is the minimum-viable merchant ask and matches "hand-onboard 1–2 partners, manual". The Shopify app (Grade A) is the mid-market scaling move and the self-serve onboarding unlock in Phase 3. Salesforce Commerce / Eagle Eye adapters follow the same adapter pattern: normalise inbound order events → Conversion Claim; normalise loyalty lookups → Identity Resolution.

**Failure mode to design for now:** merchants under-reporting conversions (token went in, claim never comes out). Mitigations layer up over time — token-mint vs claim-rate monitoring per merchant (Phase 1 analytics), contractual audit rights in the merchant agreement, and Phase 3's third-party verification making non-reporting detectable. This is the platform's honest-counterparty problem and it deserves a line in the risk register.

---

## 6. Cross-cutting decisions

**Stack.** TypeScript end-to-end (Core, trio, wallet backend; Next.js for control plane + wallet demo UI). One language maximises Claude Code leverage and lets the senior dev review everything in one idiom. Python enters only with the v2 ML sidecar. Postgres for everything stateful (ledger, offers, identities, mandates, read models — separate schemas per module, separate *database* for the trio). Redis for token-replay fast path and rate limiting. No Kafka — `LISTEN/NOTIFY` + an outbox table gives reliable event delivery at this scale; revisit at ~100 merchants.

**Hosting.** Single cloud (Fly.io or Render for velocity; AWS if the design partner's security review demands it — decide at Phase 1 hardening, migration is cheap while small). Managed Postgres with PITR from day one: the ledger is the product (P1), so backups are existential, not hygiene.

**Keys.** All signing keys in cloud KMS; the trio signs via KMS API calls, never holds raw private keys in process. Key rotation procedure documented in Phase 1 (audit-trail work item). Separate key hierarchies: platform mint keys, per-merchant keys, per-agent keys.

**Tenancy.** Single-tenant-per-row (`merchant_id` scoping + Postgres RLS as belt-and-braces). Full tenant isolation infrastructure is enterprise-tier work that waits for an enterprise customer to pay for it.

**AuthN/Z.** Agents: API key (Phase 0) → request signing (Phase 1). Merchants: session auth on control plane + webhook signatures. Consumers: passwordless (magic link) on the wallet. Internal Core→trio calls: mTLS or signed service tokens.

**Observability.** Structured logs + OpenTelemetry traces from day one — a request must be traceable from offer read → token → claim → verification → ledger entries, because *that trace is literally the demo*. The Phase 0 "record the demo" asset is largely this trace made visible.

---

## 7. Build sequencing (architecture ↔ roadmap)

| Phase | Architectural deliverables | Owner |
|---|---|---|
| **0 — Acquirable proof point** (Q3 26) | Core skeleton: Offer Service (thin feed + CPA bounties), **Quote Service (quote-bound tokens)**, Identity Resolution (minimal, seeded Aurora Club table), agent registration, REST read path, Grade-B merchant webhook adapter, **Valet v0 (scripted, walletless loop)**. **Trio v1:** Commitment Signing, token mint + Conversion Verification, thin Settlement (entries + simulated statements). Hash-chained event log underneath all three. | Claude Code (Core) · Senior dev (trio, ~4 wks) |
| **1 — Harden & first partners** (Q4 26) | MCP server surface; eligibility rules + offer composition; audit-trail hardening (hash-head publication, key rotation); mint-vs-claim monitoring; wallet backend + Consent/Mandate service; **Account Linking service + FakeAurora IdP; Web Push notifications + Approval records** | Claude Code · senior-dev review on trio-adjacent code and OAuth token storage |
| **2 — Optimiser & scale** (Q1 27) | Multi-party netting runs + commission automation (Stripe Connect); Decisioning Slot v2 (ML sidecar) trained on ledger exhaust; budget pacing guardrails; analytics dashboard over read models; **wallet demo complete incl. Valet errand UI + two-act demo (wallet + walletless)**; 1pd enrichment path (mandate-gated) | Claude Code + ML work |
| **3 — Interop & exit-ready** (Q2 27) | JSON-LD feed; UCP/ACP conformance adapters; third-party verification spec + reference verifier (open-sourced); Shopify app (Grade A) + self-serve onboarding; SKU-level offer granularity | Claude Code |

The dependency logic mirrors the strategy exactly: the trio has no dependencies on the offers engine's intelligence, the ML engine depends on the ledger's data exhaust, and the wallet depends on the public surfaces existing — so moat-first isn't just commercially right, it's the topological sort of the build graph.

---

## 8. Deliberate deferrals & open questions

**Deferred by design:** real money movement (simulated → Stripe Connect); merchant-held keys (custodied → handover); loyalty aggregation across programmes (Phase 3); payment-method decisioning (later — and possibly never core, per P5's logic about whose job payments are); full ML pipeline (v2 slot).

**Open questions for the next working session:**
1. **Clawback window economics** — how long can settlement hold agent commissions in reserve against refunds before agent developers balk? (Affiliate-network convention is 30–60 days; agents may expect faster.)
2. **Token transport per checkout type** — the Shopify cart-attribute path is clean; headless and in-agent API checkouts (ACP-style) need a per-protocol mapping table before Phase 3.
3. **Grade-B custodied signing** — confirm the design partner's security team accepts custodied merchant keys for the pilot, or pull key-handover forward.
4. **Regulatory check on settlement** — a one-hour session with a payments lawyer before real money moves in Phase 2 (PSR/EMI perimeter, agent commissions as marketing payments vs payment services).
5. **UIP defensive watch** — if Talon.One/UIP adds any conversion-verification field to the protocol, the third-party-verification open spec (Phase 3) may need to accelerate to Phase 1 as the standard-setting counter-move.
6. **Valet naming clearance** — "Valet" is a working name; run the same UK IPO/USPTO screen used for Merited before it appears in investor materials.
7. **Hosted linking liability** — where a brand has no IdP and Merited's hosted flow handles member credentials, the credential-handling posture (screen-scrape vs API vs verification email) needs a per-brand risk decision; verification-email linking is the safe default.
8. **Approval UX threshold** — where to default the pre-authorisation boundary (per-txn limit below which Valet skips explicit approval) is a product decision with real conversion-rate consequences; instrument both modes from day one.

---

*End of architecture v1.0. Treat sections 2 (spine) and 4.1 (mandates) as the senior-dev review surface; everything else is Claude Code build territory with contracts defined here.*
