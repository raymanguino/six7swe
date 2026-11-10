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

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveDatabaseTarget } from './db-env';

function main(): void {
  const target = resolveDatabaseTarget();

  const result = spawnSync('npx', ['drizzle-kit', 'migrate'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    // The URL is passed through explicitly rather than relying on the
    // environment: dotenv does not override a variable that is already set,
    // so the local .env would otherwise win over the --remote target.
    env: { ...process.env, DATABASE_URL: target.databaseUrl },
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate failed with exit code ${result.status ?? 'unknown'}`);
  }
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
