-- PH1-24: at-rest custody for envelope-encrypted signing keys (PH1-30's
-- KeyStore). Every column is SEALED or public material - the private key is
-- AES-256-GCM under a KMS data key, itself stored only encrypted. Keys are
-- immutable: the app role may create and read, never rewrite or remove.
CREATE TABLE trio.signing_keys (
  key_ref text PRIMARY KEY,
  public_key text NOT NULL,
  encrypted_private text NOT NULL,
  encrypted_data_key text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT ON trio.signing_keys TO merited_app;
