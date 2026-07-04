-- 0001 (VAL-5): Valet's OWN agent identity, persisted between runs (the
-- "register once, reuse forever" bootstrap). The api key is Valet's own
-- client credential — keychain-equivalent storage in Valet's own schema,
-- granting nothing over anyone else's data.
CREATE TABLE valet.agent_credentials (
  profile text PRIMARY KEY DEFAULT 'default',
  agent_id text NOT NULL,
  api_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON valet.agent_credentials TO merited_app;
