-- 0002 (TRIO-11): netting runs and the append-only netted-entry marker.
-- Entries are never edited when netted — a marker row is appended; the
-- netted_sets PK also arbitrates concurrent netting runs (a set folds into
-- exactly one run, ever).
CREATE TABLE trio.netting_runs (
  netting_run_id text PRIMARY KEY,
  period text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE trio.netted_sets (
  entry_set_id text PRIMARY KEY REFERENCES trio.entry_sets (entry_set_id),
  netting_run_id text NOT NULL REFERENCES trio.netting_runs (netting_run_id)
);
--> statement-breakpoint
GRANT SELECT, INSERT ON trio.netting_runs, trio.netted_sets TO merited_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON trio.netting_runs, trio.netted_sets FROM merited_app;
