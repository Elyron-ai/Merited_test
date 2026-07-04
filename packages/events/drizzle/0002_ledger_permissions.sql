-- 0002 (FND-10, BUILD-SPEC §8): append-only enforced in Postgres, not just
-- code. The explicit grant-then-revoke leaves an auditable trail.
REVOKE UPDATE, DELETE ON events.events FROM merited_app;
