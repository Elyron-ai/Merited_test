-- 0006 (VAL-13, §8/B21): trace correlation METADATA on ledger rows. The
-- column lives OUTSIDE the hashed body — the chain formula (D2) covers
-- body only, so history and verify-chain are untouched — and it is
-- nullable: appends outside any trace context simply leave it empty.
-- This completes §8's sentence: one trace ID from readOffers → mint →
-- checkout webhook → verify → LEDGER ENTRIES.
ALTER TABLE events.events ADD COLUMN trace_id char(32);
