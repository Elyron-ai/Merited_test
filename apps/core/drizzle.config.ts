import { defineConfig } from 'drizzle-kit';

/** CORE-2+ generate migrations into drizzle/; the shared forward-only runner
 * (scripts/migrate.mjs) applies them as merited_migrate. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/**/schema.ts',
  out: './drizzle',
});
