/**
 * Applies the pending knowledge-service migrations.
 *
 * Uses Drizzle's programmatic migrator rather than `drizzle-kit migrate`,
 * which exits non-zero without printing the database error.
 *
 * The ledger lives in its own `knowledge_migrations` schema: inside
 * `knowledge` it would make the migrator create that schema before the first
 * migration runs `CREATE SCHEMA "knowledge"`, and in the shared `drizzle`
 * schema the backend's `db:reset` would wipe it.
 *
 * Usage:
 *   pnpm --filter @six7swe/knowledge db:migrate
 *   DATABASE_URL=... pnpm --filter @six7swe/knowledge db:migrate   # any target
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '../drizzle.config.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: path.join(here, '..', 'migrations'),
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    process.stdout.write(`Knowledge migrations applied to ${new URL(url).hostname}.\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? (error.cause instanceof Error ? `${error.message}\n  cause: ${error.cause.message}` : error.message) : String(error)}\n`,
  );
  process.exit(1);
});
