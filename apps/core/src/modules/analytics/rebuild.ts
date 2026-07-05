import { rebuildProjection } from '@merited/events';
import pg from 'pg';
import { analyticsProjection } from './projections/index.js';

/**
 * `pnpm analytics:rebuild` (PH1-19, §5.9): wipe the four analytics tables +
 * internal index and replay the ENTIRE ledger from seq 0. Safe to run any
 * time — projections are disposable read models; the ledger is the truth.
 */
const url =
  process.env['MERITED_DATABASE_URL'] ??
  'postgres://merited_app:merited_app_dev@localhost:5432/merited';

const pool = new pg.Pool({ connectionString: url, max: 5 });
pool.on('error', () => {});

rebuildProjection(pool, analyticsProjection)
  .then(async (applied) => {
    console.log(`rebuilt ${analyticsProjection.name}: ${applied} events replayed from seq 0`);
    await pool.end();
  })
  .catch(async (error) => {
    console.error((error as Error).message);
    await pool.end();
    process.exit(1);
  });
