// Forward-only migration runner (FND-9, D8). Applies ./drizzle/*.sql in
// journal order as merited_migrate, recording state in ${migSchema}.__migrations.
// Refuses to run as any role other than merited_migrate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkChecksums } from './check-migrations.mjs';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');

export async function migrate(adminUrl = process.env.MERITED_DATABASE_ADMIN_URL, options = {}) {
  const root = options.pkgRoot ?? pkgRoot;
  const migSchema = options.schema ?? 'events';
  const url =
    adminUrl ?? 'postgres://merited_migrate:merited_migrate_dev@localhost:5432/merited';
  const user = new URL(url).username;
  if (user !== 'merited_migrate') {
    throw new Error(`migrations must run as merited_migrate, not '${user}' (D8)`);
  }

  const problems = checkChecksums(root);
  if (problems.length > 0) {
    throw new Error(`migration checksum guard failed:\n${problems.join('\n')}`);
  }

  const journal = JSON.parse(
    readFileSync(path.join(root, 'drizzle', 'meta', '_journal.json'), 'utf8'),
  );
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${migSchema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${migSchema}.__migrations (
         tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    for (const entry of journal.entries) {
      const { rows } = await client.query(`SELECT 1 FROM ${migSchema}.__migrations WHERE tag = $1`, [
        entry.tag,
      ]);
      if (rows.length > 0) continue;
      const sql = readFileSync(path.join(root, 'drizzle', `${entry.tag}.sql`), 'utf8');
      await client.query('BEGIN');
      try {
        for (const statement of sql.split('--> statement-breakpoint')) {
          if (statement.trim()) await client.query(statement);
        }
        await client.query(`INSERT INTO ${migSchema}.__migrations (tag) VALUES ($1)`, [entry.tag]);
        await client.query('COMMIT');
        applied.push(entry.tag);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then((applied) => {
      console.log(
        applied.length > 0 ? `applied: ${applied.join(', ')}` : 'no pending migrations (no-op)',
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
