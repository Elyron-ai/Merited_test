import '@merited/otel/register';
import { createCoreDb } from './db.js';
import { loadCoreEnv } from './env.js';
import { createCoreServer } from './server.js';

/** Boot entry (`pnpm --filter @merited/core dev`): fail-fast env, role-checked
 * DB pool, then listen. Module routes attach as their tasks land. */
const env = loadCoreEnv();
const database = createCoreDb(env.MERITED_DATABASE_URL);
await database.pool.query('SELECT 1'); // compose reachable before we accept traffic
const app = createCoreServer();

const shutdown = async (): Promise<void> => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

const address = await app.listen({ port: env.MERITED_CORE_PORT, host: '0.0.0.0' });
console.log(`merited-core listening at ${address}`);
