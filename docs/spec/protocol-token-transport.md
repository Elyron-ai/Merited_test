# Token transport per protocol (PH3-2 — resolves architecture §8 Q2)

Where the Merited attribution token rides in each agent-commerce checkout
flow. One designated field per protocol, both directions; adapters REFUSE
token material found anywhere else. A checkout callback whose designated
field is empty produces **no claim** — no token, no bounty (P2).

| Protocol | Direction | Payload object | Designated field | Notes |
|---|---|---|---|---|
| **UCP** | offer-out | `ucp.offer` | `extensions["com.merited.attribution"].token` | UCP's extension envelope: namespaced map, spec-legal for vendor data. `quote_id` + `expires_at` ride the same envelope. |
| **UCP** | checkout-callback-in | `ucp.checkout.completed` | `order.extensions["com.merited.attribution"].token` | The extension MUST be echoed verbatim by the checkout surface; a missing/foreign-namespaced token is ignored. |
| **ACP** | offer-out | `acp.item` | `metadata["merited:token"]` | ACP's free-form string-map metadata; keys are `merited:`-prefixed (`merited:token`, `merited:quote_id`, `merited:expires_at`). |
| **ACP** | checkout-callback-in | `acp.order.webhook` | `metadata["merited:token"]` | Same key on the order; the adapter reads ONLY this key. |
| **Shopify** (Grade A, PH3-5) | checkout | cart attribute `merited_token` | already clean per architecture §8 Q2; listed for completeness. |

**Shared rules (both protocols, enforced by the conformance harness):**
1. Exactly one designated field carries the token; adapters never scrape
   other fields, descriptions, or URLs for token-shaped strings.
2. The token is OPAQUE to the protocol: adapters never decode, split or
   transform it — byte-identical round-trip or no claim.
3. Prices cross protocols as integer minor units + ISO currency
   (`GBP` → pence). No decimals on the wire we control.
4. Callback → claim goes through the existing `CommerceAdapter`
   normalisation → signed `ConversionClaim` path (MER-4); the protocol
   adapters produce `OrderConfirmed` inputs, never claims directly.
5. The protocol payload schemas in `packages/contracts/src/protocols/` are
   CONTRACT STUBS (§2.2): the minimum both sides must agree on, versioned
   with the mapping above. Real-spec drift lands here first, contracts-first.

Status: table effective 2026-07-05 (PH3-2); PH3-3 (UCP) and PH3-4 (ACP)
build strictly against it.
