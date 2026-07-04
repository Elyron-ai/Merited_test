-- 0000_baseline (FND-9): anchor migration. Ensures the events schema exists
-- so migrate runs clean on an empty database (compose init.sql also creates
-- it; IF NOT EXISTS keeps both paths idempotent).
CREATE SCHEMA IF NOT EXISTS events;
