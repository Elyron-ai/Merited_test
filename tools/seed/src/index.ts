import { runSeed } from './seed.js';

export { runSeed, type SeedOptions, type SeedResult } from './seed.js';
export {
  AURORA_COMMERCIAL,
  AURORA_MEMBERS,
  AURORA_MERCHANT_ID,
  AURORA_OFFERS,
  type AuroraMemberFixture,
  type AuroraOfferFixture,
} from './fixtures/aurora.js';

const DEV_DATABASE_URL = 'postgres://merited_app:merited_app_dev@localhost:5432/merited';

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSeed({ databaseUrl: process.env['DATABASE_URL'] ?? DEV_DATABASE_URL }).catch((error) => {
    console.error('seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
