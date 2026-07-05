-- PH1-8: encrypted refresh-token store (B23, HIGH-SCRUTINY). Refresh/access
-- tokens for a linked loyalty account live here, AEAD-sealed via the Crypter
-- (FakeCrypter in Phase 0; KMS-data-key AEAD in PH1-30) - NEVER plaintext,
-- NEVER serialised into contracts or an API response (§3 NB, §6.3). Keyed by
-- link_id; one live row per link (rotation replaces it). Fresh test DBs skip
-- infra/postgres/init.sql, so the migration grants schema usage itself.
GRANT USAGE ON SCHEMA wallet TO merited_app;
--> statement-breakpoint
CREATE TABLE wallet.link_tokens (
  link_id text PRIMARY KEY,
  crypter_ref text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet.link_tokens TO merited_app;
