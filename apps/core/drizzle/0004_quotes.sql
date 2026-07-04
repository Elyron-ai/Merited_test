-- 0004 (CORE-10): quotes — priced promises, not reservations (§4). Rows are
-- immutable (INSERT/SELECT only; status is DERIVED: live/expired by clock,
-- converted by the ledger). inputs_snapshot is the audit trail back to "the
-- exact price and reasoning the agent was shown".
CREATE TABLE core.quotes (
  quote_id text PRIMARY KEY,
  offer_id text NOT NULL,
  commitment_id text NOT NULL,
  agent_id text,
  consumer_ref text,
  tier text NOT NULL,
  segment text NOT NULL,
  list_amount integer NOT NULL,
  final_amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'GBP_pence',
  mechanics_applied jsonb NOT NULL,
  token_jti text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inputs_snapshot jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX quotes_offer_idx ON core.quotes (offer_id);
--> statement-breakpoint
CREATE INDEX quotes_agent_idx ON core.quotes (agent_id);
--> statement-breakpoint
GRANT SELECT, INSERT ON core.quotes TO merited_app;
