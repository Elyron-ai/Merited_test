-- 0000 (TRIO-3): the trio's own schema — separate logical DB in prod
-- (BUILD-SPEC §1). Table set for §7.1–7.3; service logic lands with
-- TRIO-4…11. Default privileges in this schema grant the app role
-- SELECT/INSERT only (init.sql); mutable tables get explicit UPDATE grants.

CREATE TABLE trio.commitments (
  commitment_id text PRIMARY KEY,
  merchant_id text NOT NULL,
  offer_ref text NOT NULL,
  body jsonb NOT NULL, -- the full countersigned COR (immutable record)
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.commitment_terminations (
  commitment_id text PRIMARY KEY REFERENCES trio.commitments (commitment_id),
  ended_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
--> statement-breakpoint
CREATE TABLE trio.minted_tokens (
  jti text PRIMARY KEY,
  cid text NOT NULL,
  qid text NOT NULL,
  aid text NOT NULL,
  tier text NOT NULL,
  sid text NOT NULL,
  apr text,
  iat bigint NOT NULL,
  exp bigint NOT NULL,
  quote_expires_at timestamptz NOT NULL, -- SYN-8 snapshot
  mandate_ref text,                      -- SYN-8 snapshot (wallet-path marker)
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.consumed_jtis (
  jti text PRIMARY KEY REFERENCES trio.minted_tokens (jti),
  qid text NOT NULL UNIQUE, -- SYN-9: one verified conversion per qid
  claim_id text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.entry_sets (
  entry_set_id text PRIMARY KEY,
  claim_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.entry_lines (
  line_id bigserial PRIMARY KEY,
  entry_set_id text NOT NULL REFERENCES trio.entry_sets (entry_set_id),
  account text NOT NULL,
  side text NOT NULL CHECK (side IN ('dr', 'cr')),
  amount_pence bigint NOT NULL CHECK (amount_pence >= 0)
);
--> statement-breakpoint
CREATE TABLE trio.counters (
  commitment_id text PRIMARY KEY REFERENCES trio.commitments (commitment_id),
  conversions_used integer NOT NULL DEFAULT 0,
  budget_remaining_pence bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA trio TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA trio TO merited_app;
--> statement-breakpoint
GRANT UPDATE ON trio.counters TO merited_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA trio TO merited_app;
--> statement-breakpoint
-- Append-only, explicit and auditable (§8; task row): even though defaults
-- grant no UPDATE/DELETE here, the REVOKE records intent against drift.
REVOKE UPDATE, DELETE ON trio.commitments, trio.consumed_jtis, trio.entry_sets, trio.entry_lines FROM merited_app;
