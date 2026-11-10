/**
 * Locks the application tables down.
 *
 * Supabase grants the `anon` and `authenticated` roles full privileges on
 * every table in the `public` schema, and row level security is off unless
 * it is turned on. The frontend ships the anon key in the browser bundle,
 * so with the default grants anybody could read `portfolio_profile` (the
 * resume, the email address and the phone number) over the REST API, and
 * could write to the job-hunter tables.
 *
 * This turns row level security on, revokes the public grants, and revokes
 * the default privileges so a table created later does not inherit them.
 * The backend is unaffected: it connects as the table owner, and an owner
 * bypasses RLS.
 *
 * It has to run after every migration, because the schema cannot express
 * any of this and a recreated table starts out wide open.
 *
 * Usage:
 *   pnpm run db:secure                # local database
 *   pnpm run db:secure -- --remote    # the hosted database
 */

import postgres from 'postgres';
import { applyDatabaseSecurity } from '../src/db/security';
import { resolveDatabaseTarget, sslOptions } from './db-env';

async function main(): Promise<void> {
  const target = resolveDatabaseTarget();
  const label = target.remote ? 'REMOTE' : 'local';

  process.stdout.write(`Locking down the ${label} database.\n`);

  const sql = postgres(target.databaseUrl, { ...sslOptions(target.remote), max: 1 });

  try {
    const result = await applyDatabaseSecurity(sql);

    process.stdout.write(
      `Locked down ${result.tables.length} table(s): ${result.tables.join(', ')}\n`,
    );
    process.stdout.write(`Applied ${result.statements} statement(s).\n`);
    process.stdout.write(
      'Row level security is on and the anon and authenticated grants are revoked.\n' +
        'The backend connects as the table owner and is unaffected.\n',
    );
  } finally {
    await sql.end();
  }
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
