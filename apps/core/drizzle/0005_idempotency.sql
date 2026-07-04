-- 0005 (MER-3): adapter idempotency — Postgres is the source of truth
-- (spec §1: Redis never is). Replayed keys return the stored response
-- byte-for-byte; a different body under the same key is a 422 conflict.
CREATE TABLE core.idempotency_keys (
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key)
);
--> statement-breakpoint
GRANT SELECT, INSERT ON core.idempotency_keys TO merited_app;
