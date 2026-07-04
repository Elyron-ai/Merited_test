import pg from 'pg';

/**
 * Connection factories with role assertions (FND-9, D8): runtime code may
 * only connect as merited_app; the migration runner only as merited_migrate.
 * The assertion is mechanical so a mis-wired URL fails at boot, not at audit.
 */
export const assertUrlRole = (url: string, expectedUser: string): string => {
  const user = new URL(url).username;
  if (user !== expectedUser) {
    throw new Error(`expected a ${expectedUser} connection URL, got user '${user}' (D8)`);
  }
  return url;
};

const DEFAULT_APP_URL = 'postgres://merited_app:merited_app_dev@localhost:5432/merited';

/** Runtime pool — merited_app only (no DDL; ledger UPDATE/DELETE revoked). */
export const createAppPool = (
  url: string = process.env['MERITED_DATABASE_URL'] ?? DEFAULT_APP_URL,
): pg.Pool => {
  const pool = new pg.Pool({ connectionString: assertUrlRole(url, 'merited_app') });
  // Idle clients may error at any time (server restart, admin termination);
  // without a handler that is a process-killing uncaught exception. The pool
  // discards errored idles and the next checkout reconnects — repo idiom.
  pool.on('error', () => {});
  return pool;
};
