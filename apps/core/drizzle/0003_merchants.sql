-- 0003 (MER-2): merchants + credentials. Webhook secrets are ENCRYPTED at
-- rest via the Crypter port (verification needs the plaintext for HMAC —
-- SYN-39); API keys are HASHED (verify-only, parallel to agent_keys);
-- signing keys are REFERENCES only — private material lives behind
-- KMS/FakeSigner custody and never enters this schema (SYN-22/32).
CREATE TABLE core.merchants (
  merchant_id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  commercial jsonb NOT NULL,
  signing_key_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE core.merchant_webhook_secrets (
  secret_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  secret_ciphertext text NOT NULL,
  secret_last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX merchant_webhook_secrets_merchant_idx ON core.merchant_webhook_secrets (merchant_id);
--> statement-breakpoint
CREATE TABLE core.merchant_api_keys (
  key_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  key_hash text NOT NULL UNIQUE,
  key_last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX merchant_api_keys_merchant_idx ON core.merchant_api_keys (merchant_id);
--> statement-breakpoint
CREATE TABLE core.merchant_signing_keys (
  ref_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  signing_key_ref text NOT NULL,
  public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.merchants, core.merchant_webhook_secrets, core.merchant_api_keys, core.merchant_signing_keys TO merited_app;
