-- 0000 (CORE-2): offers storage — ONE table with the discriminated mechanics
-- union as jsonb (validated by contracts at every write boundary, §5.1;
-- "do not build 27 tables"). Counters live OUTSIDE the immutable COR and are
-- a read-model, never the enforcement point (caps enforce at verification).
CREATE TABLE core.offers (
  offer_id text PRIMARY KEY,
  merchant_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  mechanics jsonb NOT NULL,
  sku_scope jsonb NOT NULL,
  identity_tiers text[] NOT NULL,
  stacking_group text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'ended')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  current_commitment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX offers_merchant_idx ON core.offers (merchant_id);
--> statement-breakpoint
CREATE INDEX offers_status_idx ON core.offers (status);
--> statement-breakpoint
CREATE TABLE core.offer_counters (
  offer_id text PRIMARY KEY REFERENCES core.offers (offer_id),
  redeem_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE core.offer_commitments (
  offer_id text NOT NULL REFERENCES core.offers (offer_id),
  commitment_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (offer_id, commitment_id)
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA core TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.offers, core.offer_counters, core.offer_commitments TO merited_app;
