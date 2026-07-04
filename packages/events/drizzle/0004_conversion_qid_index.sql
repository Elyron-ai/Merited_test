-- 0004 (CORE-10): partial expression index for the ledger reader's
-- "converted quote" lookup — getQuoteStatus resolves ConversionVerified by
-- qid directly from the ledger (Ph0 volume needs no projection; B19 adds
-- one in Phase 1).
CREATE INDEX events_conversion_qid_idx
  ON events.events ((body->'data'->>'qid'))
  WHERE type = 'ConversionVerified';
