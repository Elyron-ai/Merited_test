-- 0000 (MER-7): internal single-team auth (§5.7 — no Clerk). Passwords are
-- argon2id hashes; TOTP secrets are per-user (otplib). Sessions exist ONLY
-- after full authentication — login always mints a fresh id and never adopts
-- a presented cookie, so session fixation is impossible by construction.
CREATE TABLE control_plane.users (
  user_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE control_plane.sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES control_plane.users (user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
GRANT USAGE ON SCHEMA control_plane TO merited_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON control_plane.users TO merited_app;
--> statement-breakpoint
-- Sessions are runtime state, not audit history: logout and rotation DELETE.
GRANT SELECT, INSERT, DELETE ON control_plane.sessions TO merited_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control_plane TO merited_app;
