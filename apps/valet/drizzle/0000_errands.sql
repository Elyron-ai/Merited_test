-- 0000 (VAL-3): errand persistence — Valet-owned schema `valet` (VAL D2),
-- shaped identically to the future wallet-backend errands table (B15) so
-- Phase 2 re-points the store without a re-model. errand_events is the
-- APPEND-ONLY per-errand log for replay/debug (SELECT/INSERT only for the
-- runtime role); the platform ledger mirror is VAL-4's, not this table.
CREATE TABLE valet.errands (
  errand_id text PRIMARY KEY,
  agent_id text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'BRIEFED', 'SEARCHING', 'QUOTED', 'AWAITING_APPROVAL', 'APPROVED',
    'EXECUTING', 'CONFIRMED', 'FAILED', 'DECLINED', 'EXPIRED'
  )),
  brief jsonb NOT NULL,
  mandate_id text,
  approval_id text,
  consumer_ref text,
  sub_hash text,
  quote_id text,
  token text,
  claim_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX errands_state_idx ON valet.errands (state);
--> statement-breakpoint
CREATE TABLE valet.errand_events (
  seq bigserial PRIMARY KEY,
  errand_id text NOT NULL REFERENCES valet.errands (errand_id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  event jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX errand_events_errand_idx ON valet.errand_events (errand_id, seq);
--> statement-breakpoint
GRANT USAGE ON SCHEMA valet TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON valet.errands TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON valet.errand_events TO merited_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE valet.errand_events_seq_seq TO merited_app;
