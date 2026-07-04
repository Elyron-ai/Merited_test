-- Merited local Postgres bootstrap (FND-2).
-- Runs once on first container start (empty volume). Creates the D8 roles and
-- per-module schemas. The trio gets its own schema locally; its own logical
-- database in prod (BUILD-SPEC §1). REVOKE UPDATE/DELETE on ledger tables is
-- applied by FND-10's migration, not here — this file only sets up roles/schemas.

-- D8 roles ---------------------------------------------------------------
-- merited_migrate: DDL, used only by the migration runner.
-- merited_app:     runtime; no DDL. Ledger REVOKEs land with FND-10.
CREATE ROLE merited_migrate LOGIN PASSWORD 'merited_migrate_dev';
CREATE ROLE merited_app LOGIN PASSWORD 'merited_app_dev';

-- The migration runner creates schemas/tables: it needs CREATE on the database.
GRANT CREATE ON DATABASE merited TO merited_migrate;

-- Per-module schemas -------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS events AUTHORIZATION merited_migrate;
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION merited_migrate;
CREATE SCHEMA IF NOT EXISTS trio AUTHORIZATION merited_migrate;
CREATE SCHEMA IF NOT EXISTS wallet AUTHORIZATION merited_migrate;
CREATE SCHEMA IF NOT EXISTS valet AUTHORIZATION merited_migrate;
CREATE SCHEMA IF NOT EXISTS control_plane AUTHORIZATION merited_migrate;

-- Runtime role usage (table-level grants are issued by migrations as tables
-- are created; ALTER DEFAULT PRIVILEGES keeps future tables covered).
GRANT USAGE ON SCHEMA events, core, trio, wallet, valet, control_plane TO merited_app;
ALTER DEFAULT PRIVILEGES FOR ROLE merited_migrate IN SCHEMA events, core, wallet, valet, control_plane
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO merited_app;
-- Trio tables default tighter: SELECT/INSERT only; migrations grant UPDATE
-- explicitly where a table is legitimately mutable (append-only by default).
ALTER DEFAULT PRIVILEGES FOR ROLE merited_migrate IN SCHEMA trio
  GRANT SELECT, INSERT ON TABLES TO merited_app;
ALTER DEFAULT PRIVILEGES FOR ROLE merited_migrate IN SCHEMA events, core, trio, wallet, valet, control_plane
  GRANT USAGE, SELECT ON SEQUENCES TO merited_app;
