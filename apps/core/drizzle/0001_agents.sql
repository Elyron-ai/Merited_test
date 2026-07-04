-- 0001 (CORE-3): agent registry — hashed keys only (the clear key is
-- returned exactly once at registration and never stored). alg/public_key
-- are the Phase-1 upgrade path (Ed25519 request signing, CORE-P1-1):
-- columns exist, no signing code ships in Phase 0 (§2.1 B4).
CREATE TABLE core.agents (
  agent_id text PRIMARY KEY,
  name text NOT NULL,
  contact text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE core.agent_keys (
  key_id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES core.agents (agent_id),
  key_hash text NOT NULL UNIQUE,
  key_last4 text NOT NULL,
  alg text NOT NULL DEFAULT 'api_key',
  public_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX agent_keys_agent_idx ON core.agent_keys (agent_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.agents, core.agent_keys TO merited_app;
