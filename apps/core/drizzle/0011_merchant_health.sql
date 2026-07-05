-- PH1-20: mint-vs-claim monitor state — the per-merchant health verdict the
-- control-plane badge reads (architecture §5: under-reporting "deserves a
-- line in the risk register"). Written by the monitor on every evaluation
-- cycle; disposable monitor output, not ledger truth.
CREATE TABLE core.merchant_health (
  merchant_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('healthy', 'under_reporting', 'insufficient_data')),
  claim_rate_bps integer,
  mints bigint NOT NULL DEFAULT 0,
  claims bigint NOT NULL DEFAULT 0,
  window_days integer NOT NULL,
  floor_bps integer NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON core.merchant_health TO merited_app;
