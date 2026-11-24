/**
 * Locks the application tables down.
 *
 * Supabase grants the `anon` and `authenticated` roles full privileges on
 * every table in the `public` schema, and row level security is off unless
 * it is turned on. The frontend ships the anon key in the browser bundle,
 * so with the default grants anybody could read and write the job-hunter
 * tables (users and their email addresses, search profiles, matches) over the
 * REST API.
 *
 * This turns row level security on, revokes the public grants, and revokes
 * the default privileges so a table created later does not inherit them.
 *
 * It connects as the table owner (`DATABASE_MIGRATION_URL`, or `DATABASE_URL`
 * when that is unset). When `DATABASE_URL` names another role, it creates that
 * role (or resets its password to the one in the URL) and grants it read and
 * write access to the rows, so the backend runs without the owner's rights.
 *
 * It has to run after every migration, because the schema cannot express
 * any of this and a recreated table starts out wide open.
 *
 * Usage:
 *   pnpm run db:secure                # local database
 *   pnpm run db:secure -- --remote    # the hosted database
 */

import { resolveDatabaseTarget } from './db-env';
import { describeAppRole, lockDownDatabase } from './db-lockdown';

async function main(): Promise<void> {
  const target = resolveDatabaseTarget();
  const label = target.remote ? 'REMOTE' : 'local';

  process.stdout.write(`Locking down the ${label} database.\n`);

  const result = await lockDownDatabase(target);

  process.stdout.write(
    `Locked down ${result.tables.length} table(s): ${result.tables.join(', ')}\n`,
  );
  process.stdout.write(`Applied ${result.statements} statement(s).\n`);
  process.stdout.write(
    'Row level security is on and the anon and authenticated grants are revoked.\n',
  );
  process.stdout.write(describeAppRole(result));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Lockdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
