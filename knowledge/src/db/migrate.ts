/**
 * Applies the pending knowledge-service migrations.
 *
 * Uses Drizzle's programmatic migrator rather than `drizzle-kit migrate`,
 * which exits non-zero without printing the database error.
 *
 * It lives in `src` so `tsc` compiles it to `dist/db/migrate.js`: the Railway
 * pre-deploy step runs it with plain `node`, needing only runtime
 * dependencies (no tsx, drizzle-kit or dotenv).
 *
 * Usage:
 *   pnpm --filter @six7swe/knowledge db:migrate        # dev: tsx, reads .env if present
 *   pnpm --filter @six7swe/knowledge db:migrate:prod   # compiled: DATABASE_URL from the environment
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describeError } from '../lib/describeError.js';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './ledger.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  // src/db/migrate.ts and dist/db/migrate.js are both two levels below the package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: path.join(here, '..', '..', 'migrations'),
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    process.stdout.write(`Knowledge migrations applied to ${new URL(url).hostname}.\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${describeError(error)}\n`);
  process.exit(1);
});
