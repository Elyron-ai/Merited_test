import pg from 'pg';

let pool: pg.Pool | null = null;

/** Runtime pool (merited_app). Lazy singleton — Next.js route handlers and
 * server components share it across requests. */
export const getPool = (): pg.Pool => {
  if (!pool) {
    pool = new pg.Pool({
      connectionString:
        process.env['MERITED_DATABASE_URL'] ??
        'postgres://merited_app:merited_app_dev@localhost:5432/merited',
      max: 5,
    });
    pool.on('error', () => {});
  }
  return pool;
};
