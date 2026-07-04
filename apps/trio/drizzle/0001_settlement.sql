-- 0001 (TRIO-9): settlement additions — per-mandate month spend counters and
-- DB-level balance enforcement (unbalanced entry sets fail at COMMIT, not
-- just in code).
CREATE TABLE trio.mandate_month_spend (
  mandate_ref text NOT NULL,
  month text NOT NULL, -- YYYY-MM
  spent_pence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (mandate_ref, month)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON trio.mandate_month_spend TO merited_app;
--> statement-breakpoint
CREATE FUNCTION trio.check_entry_set_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dr_total bigint;
  cr_total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_pence) FILTER (WHERE side = 'dr'), 0),
         COALESCE(SUM(amount_pence) FILTER (WHERE side = 'cr'), 0)
    INTO dr_total, cr_total
    FROM trio.entry_lines
   WHERE entry_set_id = NEW.entry_set_id;
  IF dr_total <> cr_total THEN
    RAISE EXCEPTION 'entry set % does not balance: dr % <> cr %',
      NEW.entry_set_id, dr_total, cr_total;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER entry_set_balance
AFTER INSERT ON trio.entry_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trio.check_entry_set_balance();
