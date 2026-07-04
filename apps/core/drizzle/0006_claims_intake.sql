-- 0006 (MER-4): claims intake — ONE table name across the plan (SYN-5).
-- The thin audit row per submitted claim: verdict/reason updated once when
-- the trio answers (the trio's ledger remains the source of truth).
CREATE TABLE core.claims_intake (
  claim_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES core.merchants (merchant_id),
  order_ref_hash text NOT NULL,
  gross_pence integer NOT NULL,
  jti text,
  qid text,
  cid text,
  verdict text NOT NULL DEFAULT 'pending' CHECK (verdict IN ('pending', 'verified', 'rejected')),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX claims_intake_merchant_idx ON core.claims_intake (merchant_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON core.claims_intake TO merited_app;
