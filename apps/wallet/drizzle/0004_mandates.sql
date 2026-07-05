-- PH1-16 (B14): consent & mandate service. A mandate is the consumer's grant
-- of authority to an agent; an attenuation is a narrower CHILD referencing its
-- parent (widening is rejected in code, by construction). Revocation is
-- immediate — eligibility and checkout:execute read status LIVE, never cached
-- (the app role gets no DELETE here; status flips via UPDATE, append-only).
CREATE TABLE wallet.mandates (
  mandate_id text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  agent_id text NOT NULL,
  parent_id text REFERENCES wallet.mandates (mandate_id),
  scopes jsonb NOT NULL,
  limits jsonb NOT NULL,
  merchants jsonb NOT NULL,
  data_sharing jsonb NOT NULL,
  pre_authorised_up_to jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  exp timestamptz NOT NULL,
  attestation text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX mandates_consumer_idx ON wallet.mandates (consumer_ref);
--> statement-breakpoint
-- approvals: wallet-path authorisations of a specific quote, single-use and
-- quote-bound (§6.4). The pre_authorised IMPLICIT approval is recorded here at
-- PH1-16; explicit approvals arrive at PH1-18 through the same table.
CREATE TABLE wallet.approvals (
  approval_id text PRIMARY KEY,
  mandate_id text NOT NULL REFERENCES wallet.mandates (mandate_id),
  quote_id text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('explicit', 'pre_authorised')),
  approved_at timestamptz NOT NULL DEFAULT now(),
  exp timestamptz NOT NULL,
  attestation text NOT NULL
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON wallet.mandates, wallet.approvals TO merited_app;
