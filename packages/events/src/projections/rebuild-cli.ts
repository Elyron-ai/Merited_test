import { createAppPool } from '../db.js';
import { eventsByTypeDay } from './events-by-type-day.js';
import { rebuildProjection } from './framework.js';

// Registered projections rebuild entrypoint (FND-12; B19's analytics:rebuild
// aliases this pattern in Phase 1).
const pool = createAppPool();
rebuildProjection(pool, eventsByTypeDay)
  .then(async (applied) => {
    console.log(`rebuilt ${eventsByTypeDay.name}: ${applied} events replayed`);
    await pool.end();
  })
  .catch(async (error) => {
    console.error((error as Error).message);
    await pool.end();
    process.exit(1);
  });
