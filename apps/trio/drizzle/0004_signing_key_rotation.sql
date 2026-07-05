-- PH1-22: key rotation. A key ref now holds VERSIONS (key ids); rotation adds
-- a row, revocation stamps revoked_at on one version. Existing single-version
-- rows become version 'v0' (their key_id predates the content-derived
-- convention; verification only needs uniqueness). `id` gives a strict
-- creation order for "newest active" that survives same-millisecond inserts.
-- The app role gains UPDATE on revoked_at ONLY — sealed material stays
-- immutable at the role level.
ALTER TABLE trio.signing_keys ADD COLUMN key_id text NOT NULL DEFAULT 'v0';
--> statement-breakpoint
ALTER TABLE trio.signing_keys ADD COLUMN revoked_at timestamptz;
--> statement-breakpoint
ALTER TABLE trio.signing_keys ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;
--> statement-breakpoint
ALTER TABLE trio.signing_keys DROP CONSTRAINT signing_keys_pkey;
--> statement-breakpoint
ALTER TABLE trio.signing_keys ADD PRIMARY KEY (key_ref, key_id);
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON trio.signing_keys TO merited_app;
