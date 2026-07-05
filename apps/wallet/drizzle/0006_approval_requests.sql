-- PH2-4 (§6.6/§6.4): the agent↔wallet approval rendezvous. One row per
-- quote: created when an agent requests approval under a mandate; resolved
-- either immediately (pre-authorised — implicit approval recorded) or by the
-- consumer's explicit approve/decline through PH1-18's endpoints. The valet
-- polls status here; the re-minted apr token is picked up from this row.
CREATE TABLE wallet.approval_requests (
  quote_id text PRIMARY KEY,
  mandate_id text NOT NULL REFERENCES wallet.mandates (mandate_id),
  consumer_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'refused')),
  reason text,
  mode text CHECK (mode IN ('explicit', 'pre_authorised')),
  approval_id text,
  token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON wallet.approval_requests TO merited_app;
