-- PH1-11: the static-table LoyaltyLookup impl gains balance + idempotent
-- credit. points_balance on the Phase-0 membership table; a credits ledger
-- whose UNIQUE order_ref_hash makes points-credit idempotent per order.
ALTER TABLE core.aurora_club_members ADD COLUMN points_balance integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE core.loyalty_credits (
  order_ref_hash text PRIMARY KEY,
  member_ref text NOT NULL REFERENCES core.aurora_club_members (member_ref),
  points integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT ON core.loyalty_credits TO merited_app;
