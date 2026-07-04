-- 0001 (FND-10): the append-only event ledger — exactly the §3 row shape.
CREATE TABLE events.events (
  seq bigserial PRIMARY KEY,
  evt_id text NOT NULL UNIQUE,
  type text NOT NULL,
  body jsonb NOT NULL,
  prev_hash char(64) NOT NULL,
  this_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX events_type_idx ON events.events (type);
--> statement-breakpoint
GRANT USAGE ON SCHEMA events TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON events.events TO merited_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE events.events_seq_seq TO merited_app;
