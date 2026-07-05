-- PH1-9: the §6.2 wallet tables. All forward-only; the app role manages
-- runtime rows (magic-link consumption, session lifecycle, consented 1PD).
-- consumers: the pseudonymous wallet account.
CREATE TABLE wallet.consumers (
  consumer_ref text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- identity_links: the IdentityLink contract (B23); tokens live in link_tokens.
CREATE TABLE wallet.identity_links (
  link_id text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  merchant_id text NOT NULL,
  programme text NOT NULL,
  member_ref text NOT NULL,
  sub_hash text NOT NULL,
  scopes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  linked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX identity_links_consumer_idx ON wallet.identity_links (consumer_ref);
--> statement-breakpoint
-- pd_store: consented key-values; reads are mandate-gated in code.
CREATE TABLE wallet.pd_store (
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  key text NOT NULL,
  value jsonb NOT NULL,
  consented boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_ref, key)
);
--> statement-breakpoint
-- errands: SCHEMA ONLY here (Valet full is Phase 2 / B17).
CREATE TABLE wallet.errands (
  errand_id text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  state text NOT NULL,
  brief jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE wallet.push_subscriptions (
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  endpoint text NOT NULL,
  keys jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_ref, endpoint)
);
--> statement-breakpoint
-- points read model (projection; wallet displays, never sources truth).
CREATE TABLE wallet.points_balances (
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  merchant_id text NOT NULL,
  programme text NOT NULL,
  balance_points integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_ref, merchant_id, programme)
);
--> statement-breakpoint
-- magic_links: single-use, expiring sign-in tokens (only the hash is stored).
CREATE TABLE wallet.magic_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
-- wallet_sessions: server-side session records (the app role holds DELETE
-- here for logout/expiry — the one wallet table where that is legitimate).
CREATE TABLE wallet.sessions (
  session_id text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  wallet.consumers, wallet.identity_links, wallet.pd_store, wallet.errands,
  wallet.push_subscriptions, wallet.points_balances, wallet.magic_links, wallet.sessions
  TO merited_app;
