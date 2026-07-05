-- PH1-3: merchant exclusion rules (the one data-driven stage of the fixed
-- 5.4 filter chain). Config rows, not ledger - the app role may manage them
-- (the control-plane authoring screen creates and deletes).
CREATE TABLE core.eligibility_rules (
  rule_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX eligibility_rules_merchant_idx ON core.eligibility_rules (merchant_id);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON core.eligibility_rules TO merited_app;
