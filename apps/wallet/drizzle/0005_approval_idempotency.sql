-- PH1-18 (B26): idempotency for the approve endpoint (§8: endpoints accept an
-- Idempotency-Key; replays return the ORIGINAL result). The stored response
-- exists so a replayed approve returns the SAME re-minted token instead of
-- minting again — a retried approve must never fan out fresh jtis.
CREATE TABLE wallet.idempotency_keys (
  idem_key text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  quote_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT ON wallet.idempotency_keys TO merited_app;
