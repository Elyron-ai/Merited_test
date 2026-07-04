-- 0002 (CORE-4): identity resolution tables. aurora_club_members is the
-- Phase-0 T1 stand-in (schema CORE owns, rows VAL-9 owns); a revoked row
-- must never resolve T1. soft_identities is the T2 hashed-email read-model —
-- hashes only, no raw identifiers anywhere in this schema.
CREATE TABLE core.aurora_club_members (
  member_ref text PRIMARY KEY,
  sub_hash text NOT NULL,
  loyalty_tier text NOT NULL CHECK (loyalty_tier IN ('Member', 'Gold')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  consumer_ref text
);
--> statement-breakpoint
CREATE INDEX aurora_members_sub_hash_idx ON core.aurora_club_members (sub_hash);
--> statement-breakpoint
CREATE INDEX aurora_members_consumer_idx ON core.aurora_club_members (consumer_ref);
--> statement-breakpoint
CREATE TABLE core.soft_identities (
  hash text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.aurora_club_members, core.soft_identities TO merited_app;
