import { assertUrlRole } from '@merited/events';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export interface CoreDb {
  pool: pg.Pool;
  db: NodePgDatabase;
  close(): Promise<void>;
}

/**
 * Core database access (CORE-1): runtime connections are merited_app only
 * (D8 — the role assertion makes a mis-wired URL fail at boot). Tables live
 * in the `core` schema; migrations arrive with CORE-2 via the shared
 * forward-only runner, run as merited_migrate.
 */
export const createCoreDb = (url: string): CoreDb => {
  const pool = new pg.Pool({ connectionString: assertUrlRole(url, 'merited_app'), max: 10 });
  pool.on('error', () => {});
  return { pool, db: drizzle(pool), close: () => pool.end() };
};
