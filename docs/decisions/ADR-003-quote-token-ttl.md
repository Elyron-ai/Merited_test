# ADR-003 — Quote TTL default and the token-TTL relationship

**Status:** accepted (week 1; XC.8 D3, SYN-8/30)

## Context

The quote's life and the attribution token's life interlock: a token that
outlives its quote breaks stage 4's `QUOTE_EXPIRED` check; a quote that
outlives its token strands payable reads. Both numbers are baked into B24,
TRIO-5/6/8 and both demo acts.

## Decision

- Quote TTL default: **15 minutes** (§3 `OfferQuote`).
- Token TTL: `exp = iat + min(600s, attribution_window_s)` — the ~10-minute
  §2.3 default, capped by the commitment's window.
- Invariant, enforced at mint: `quote.expires_at ≤ token exp`, else
  `422 QUOTE_EXPIRY_EXCEEDS_TOKEN`. Core therefore CLAMPS the payable
  quote's expiry to the token's horizon before calling mint (CORE-10) — the
  10-minute token deliberately clamps payable quotes below the 15-minute
  read default, and both numbers were confirmed together.
- Demo negatives use the env-gated TTL override `MERITED_QUOTE_TTL_S`
  (honoured only when `MERITED_ENV=dev|test|demo` — SYN-30); the trio itself
  has no test backdoors.

## Consequences

- A verified conversion can never cite a quote that was already stale when
  its token was minted.
- Anonymous (unpayable) quotes keep the full 15 minutes; only payable quotes
  clamp.

**Implemented in:** `apps/trio/src/verification/simulator.ts` (mint guard),
`apps/core/src/modules/quotes/` (clamp), contracts `OfferQuote`.
