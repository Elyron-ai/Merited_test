-- W10/#26: reserve-before-work idempotency. Previously withIdempotency ran the
-- claim funnel (ConversionClaimed + claims_intake) BEFORE reserving the key, so
-- two concurrent deliveries of the same key both executed the side-effects,
-- writing duplicate ledger events + intake rows. The fix reserves the key FIRST
-- (response columns NULL = a pending reservation) so only the winner runs
-- work(); the winner then fills in its response, and a concurrent loser waits
-- for and returns that stored response. That requires:
--   * a nullable response (the pending marker),
--   * UPDATE (the winner fills the reservation in on completion),
--   * DELETE (release a reservation whose work() threw, so a retry can proceed
--     — scoped in code to rows still pending, i.e. response_status IS NULL).
ALTER TABLE core.idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE core.idempotency_keys ALTER COLUMN response_body DROP NOT NULL;
--> statement-breakpoint
GRANT UPDATE, DELETE ON core.idempotency_keys TO merited_app;
