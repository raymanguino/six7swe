/**
 * Applies the pending migrations.
 *
 * The migrations are generated from the schema in src/db/schema/ and are
 * applied in order. `drizzle-kit migrate` records what it applied in
 * `drizzle.__drizzle_migrations`, so running it twice is a no-op.
 *
 * Usage:
 *   pnpm run db:migrate                # local database
 *   pnpm run db:migrate -- --remote    # the hosted database
 */

import { resolveDatabaseTarget, runMigrations } from './db-env';

function main(): void {
  runMigrations(resolveDatabaseTarget());
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
