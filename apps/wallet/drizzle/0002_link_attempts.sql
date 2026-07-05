-- PH1-13: pending OAuth link attempts. The PKCE code_verifier is stored
-- SERVER-SIDE (never sent to the browser) and bound to the state; the
-- callback looks the attempt up by state, so a stolen code is useless
-- without the server-held verifier. Single-use, short-lived.
CREATE TABLE wallet.link_attempts (
  state text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  merchant_id text NOT NULL,
  programme text NOT NULL,
  code_verifier text NOT NULL,
  return_url text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet.link_attempts TO merited_app;
