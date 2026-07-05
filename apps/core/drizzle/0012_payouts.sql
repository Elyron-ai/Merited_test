-- PH1-29 (§2.2): SimulatedPayouts — the Phase-1 PayoutRail BEHAVIOUR
-- (statements only; money never moves). payout_accounts pins one stable
-- account_ref per party; payout_statements are the artefacts a netting run
-- produces. UNIQUE(idempotency_key) is the no-double-payout guarantee the
-- shared adapter contract test (and later StripeConnectPayouts) relies on.
CREATE TABLE core.payout_accounts (
  party text PRIMARY KEY,
  account_ref text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE core.payout_statements (
  transfer_ref text PRIMARY KEY,
  account_ref text NOT NULL REFERENCES core.payout_accounts (account_ref),
  amount_pence bigint NOT NULL,
  currency text NOT NULL DEFAULT 'GBP_pence',
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'reversed')),
  -- driver enrichment (which netting fold produced this artefact)
  direction text CHECK (direction IN ('payable', 'receivable')),
  netting_run_id text,
  period text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON core.payout_accounts, core.payout_statements TO merited_app;
