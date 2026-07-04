# Adapters — the mint-vs-claim data contract (MER-6 → B19)

The Grade-B adapter makes four commitments that Phase 1's analytics (B19,
the mint-vs-claim monitor) builds on. All four are enforced by
`under-reporting.integration.test.ts` — they are executable promises, not
documentation.

1. **Accepted intake always emits `ConversionClaimed`** — even when the
   trio's verdict is `rejected`. A rejected replay is still a claim the
   merchant made; the ledger records it. (The one boundary: a token so
   malformed it does not decode still submits to the trio — and is rejected
   `SIG_INVALID` — but cannot appear in `ConversionClaimed`, whose schema
   requires the decoded `jti/qid/cid`.)
2. **Mints minus claims per merchant per day is computable from events
   alone**: `CommitmentCreated` maps `cid → merchant_id`; `TokenMinted`
   joins through `claims.cid`; `ConversionClaimed` carries `merchant_id`
   directly. No projection is required at Phase-0 volume; B19 adds one in
   Phase 1 without changing the data.
3. **Signature-rejected deliveries never touch the ledger.** They produce
   exactly one structured log line (`merchant_slug`, `reason`,
   `traceparent`) and a uniform 401 — an attacker probing the webhook
   surface leaves no trace in the hash chain.
4. **Token-less orders are dropped, not claimed** (P2: no token, no
   bounty). They are ordinary non-agent commerce — a structured
   `TOKEN_ABSENT` log, no claim row, no event.

Under-reporting detection (architecture §5): a merchant that silently drops
webhooks shows up as a growing mints-minus-claims gap per day. The
`FAKESHOP_DROP_WEBHOOK_PCT` flag on FakeShop (MER-11) exists to rehearse
exactly this in Phase 1.
