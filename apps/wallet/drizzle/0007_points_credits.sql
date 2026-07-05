-- PH2-10 (§2.2/Act 2 step 6): loyalty points credited on wallet-path
-- verified conversions. EXECUTION RECORD, not a disposable read model —
-- claim_id is the per-claim idempotency gate (the loyalty adapter's
-- order_ref_hash idempotency is the second belt), and the rows feed wallet
-- screens 1 (balances) and 6 (activity & settlement).
CREATE TABLE wallet.points_credits (
  claim_id text PRIMARY KEY,
  consumer_ref text NOT NULL,
  programme text NOT NULL,
  member_ref text NOT NULL,
  points integer NOT NULL,
  order_ref_hash text NOT NULL,
  quote_id text NOT NULL,
  gross_pence bigint NOT NULL,
  credited_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT ON wallet.points_credits TO merited_app;
