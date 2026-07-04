-- 0003 (FND-12): projection cursors + the reference projection. Projections
-- are disposable read models (rebuildable from seq 0) — mutable by design,
-- unlike the ledger itself.
CREATE TABLE events.projection_cursors (
  projection_name text PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE events.events_by_type_day (
  type text NOT NULL,
  day date NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (type, day)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON events.projection_cursors, events.events_by_type_day TO merited_app;
