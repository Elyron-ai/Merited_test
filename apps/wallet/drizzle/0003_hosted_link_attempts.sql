-- PH1-14: hosted-linking fallback for IdP-less programmes. A member-number +
-- verification-email loop (NEVER credential capture — architecture §8 names
-- verification-email as the safe default) that yields the SAME IdentityLink as
-- the OAuth path. Only the token HASH is stored (a DB read never yields a
-- usable token). Single-use, short-lived. A row exists ONLY once the member
-- number is confirmed against the brand loyalty API, so redemption cannot
-- mint a link for a non-member.
CREATE TABLE wallet.hosted_link_attempts (
  attempt_id text PRIMARY KEY,
  consumer_ref text NOT NULL REFERENCES wallet.consumers (consumer_ref),
  merchant_id text NOT NULL,
  programme text NOT NULL,
  member_ref text NOT NULL,
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON wallet.hosted_link_attempts TO merited_app;
