import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle config for the events package (FND-9, D8). Migrations run as the
 * merited_migrate role via MERITED_DATABASE_ADMIN_URL — never the app role.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env['MERITED_DATABASE_ADMIN_URL'] ??
      'postgres://merited_migrate:merited_migrate_dev@localhost:5432/merited',
  },
  migrations: {
    schema: 'events',
    table: '__migrations',
  },
});
