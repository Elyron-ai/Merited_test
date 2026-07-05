-- PH1-19 (B19, §5.9): analytics projections — DISPOSABLE read models rebuilt
-- from the ledger at any time (projections are disposable, the ledger isn't).
-- The app role holds DELETE here BY DESIGN: reset+rebuild wipes these tables;
-- the ledger's append-only guarantees live in the events schema, not here.
--
-- analytics_* tables are the projection's internal index (ledger-derived
-- lookups: commitment→merchant/bounty, token→agent, claim→bounty).
CREATE TABLE core.analytics_commitments (
  commitment_id text PRIMARY KEY,
  merchant_id text NOT NULL,
  bounty jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE core.analytics_tokens (
  jti text PRIMARY KEY,
  agent_id text NOT NULL,
  commitment_id text NOT NULL
);
--> statement-breakpoint
CREATE TABLE core.analytics_claims (
  claim_id text PRIMARY KEY,
  commitment_id text NOT NULL,
  agent_id text NOT NULL,
  bounty_pence bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE core.conversions_by_agent_day (
  agent_id text NOT NULL,
  day date NOT NULL,
  conversions bigint NOT NULL DEFAULT 0,
  gross_pence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
--> statement-breakpoint
CREATE TABLE core.mint_vs_claim_by_merchant_day (
  merchant_id text NOT NULL,
  day date NOT NULL,
  mints bigint NOT NULL DEFAULT 0,
  claims bigint NOT NULL DEFAULT 0,
  verified bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, day)
);
--> statement-breakpoint
-- §3: "both sides must see why" — reason breakdowns queryable per merchant
-- AND per agent ('(unknown)' when the token itself was unparseable).
CREATE TABLE core.rejections_by_reason_day (
  day date NOT NULL,
  reason_code text NOT NULL,
  merchant_id text NOT NULL,
  agent_id text NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, reason_code, merchant_id, agent_id)
);
--> statement-breakpoint
-- Bounty burned per commitment per day (reversals credit back on their own
-- day). The REMAINING budget is trio counter state (SYN-12), not a projection.
CREATE TABLE core.budget_burn (
  commitment_id text NOT NULL,
  merchant_id text NOT NULL,
  day date NOT NULL,
  bounty_burned_pence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (commitment_id, day)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.analytics_commitments, core.analytics_tokens, core.analytics_claims,
  core.conversions_by_agent_day, core.mint_vs_claim_by_merchant_day,
  core.rejections_by_reason_day, core.budget_burn
  TO merited_app;
