-- 0007 (VAL-7 enabler): persist the verdict's entries_preview on the intake
-- row so BOTH parties can see the settlement lines through their claim
-- surfaces (§10 step 6 / B18's CLI print). The trio's ledger remains the
-- source of truth — this is the same read-model role the verdict column
-- already plays.
ALTER TABLE core.claims_intake ADD COLUMN entries_preview jsonb;
