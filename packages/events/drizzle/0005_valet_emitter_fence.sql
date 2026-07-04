-- 0005 (VAL-4, SYN-21): the Valet emitter fence — enforced in Postgres, not
-- just code. merited_valet is Valet's ledger-mirror credential; an unfenced
-- append credential would be a P5 backdoor (Valet could write any catalogue
-- event, and quote status is DERIVED from ConversionVerified events). The
-- trigger pins the role to `ErrandStateChanged` rows only; UPDATE/DELETE are
-- revoked as they are for every runtime role (append-only, §8). Grants are
-- guarded so databases on clusters without the role still migrate cleanly.
CREATE OR REPLACE FUNCTION events.enforce_valet_emitter_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'merited_valet' AND NEW.type <> 'ErrandStateChanged' THEN
    RAISE EXCEPTION 'valet emitter fence (SYN-21): merited_valet may append ErrandStateChanged only, not %', NEW.type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER valet_emitter_fence
  BEFORE INSERT ON events.events
  FOR EACH ROW
  EXECUTE FUNCTION events.enforce_valet_emitter_fence();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'merited_valet') THEN
    GRANT USAGE ON SCHEMA events TO merited_valet;
    -- SELECT is required by the append algorithm (chain-head read); INSERT is
    -- the mirror itself. No UPDATE/DELETE — explicit REVOKE for the audit trail.
    GRANT SELECT, INSERT ON events.events TO merited_valet;
    REVOKE UPDATE, DELETE ON events.events FROM merited_valet;
    GRANT USAGE, SELECT ON SEQUENCE events.events_seq_seq TO merited_valet;
  END IF;
END
$$;
