/**
 * Rebuilds the database from scratch.
 *
 * There are no migration files: the Drizzle schema in src/db/schema/ is the
 * single source of truth. This script drops everything in the `public`
 * schema and recreates it from that schema.
 *
 * The Supabase-managed schemas (auth, storage, graphql_public) are left
 * alone, so Supabase Auth users survive a reset.
 *
 * The database is left empty unless `--seed` is passed. The portfolio is
 * never seeded here: its data lives in gitignored files, so it is applied
 * separately with `pnpm run db:seed-portfolio`.
 *
 * Usage:
 *   pnpm run db:reset                    # local database, empty
 *   pnpm run db:reset -- --seed          # local database, with dev data
 *   pnpm run db:reset -- --remote        # the hosted database, empty
 *   pnpm run db:reset -- --remote --yes  # hosted database, no prompt
 */

import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import path from 'node:path';
import postgres from 'postgres';
import { applyDatabaseSecurity } from '../src/db/security';
import { assumesYes, resolveDatabaseTarget, sslOptions, wantsSeed } from './db-env';

/**
 * Drops every table and enum in the `public` schema.
 *
 * `CASCADE` removes the dependent indexes, constraints and sequences.
 * The schema itself and its grants are kept, so the roles Supabase relies
 * on (anon, authenticated, service_role) keep working.
 */
async function dropPublicSchema(sql: postgres.Sql): Promise<string[]> {
  const tables = await sql<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `;

  const enums = await sql<{ typname: string }[]>`
    select t.typname
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'
    order by t.typname
  `;

  const dropped: string[] = [];

  for (const { tablename } of tables) {
    await sql.unsafe(`drop table if exists public."${tablename}" cascade`);
    dropped.push(tablename);
  }

  for (const { typname } of enums) {
    await sql.unsafe(`drop type if exists public."${typname}" cascade`);
    dropped.push(typname);
  }

  return dropped;
}

/**
 * Applies the Drizzle schema to the database.
 *
 * `drizzle-kit push` reconciles the live database with the schema files, so
 * it works without any migration history. `--force` skips the interactive
 * confirmation, which this script does not need.
 */
function pushSchema(): void {
  const result = spawnSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed with exit code ${result.status ?? 'unknown'}`);
  }
}

/**
 * Applies the access rules the Drizzle schema cannot express.
 *
 * The schema is the source of truth for the tables, but row level security
 * and the role grants live outside it, so they have to be applied after
 * every push. See src/db/security.ts.
 */
async function lockDownSchema(): Promise<void> {
  const target = resolveDatabaseTarget();
  const sql = postgres(target.databaseUrl, { ...sslOptions(target.remote), max: 1 });

  try {
    const result = await applyDatabaseSecurity(sql);
    process.stdout.write(`Locked down ${result.tables.length} table(s) with row level security.\n`);
  } finally {
    await sql.end();
  }
}

/**
 * Confirms a destructive reset of the hosted database.
 *
 * The reset drops every table in the public schema, so a mistake destroys
 * real data. The target host is printed so it can be checked against the
 * dashboard, and the host has to be typed back to continue.
 */
async function confirmRemoteReset(databaseUrl: string): Promise<void> {
  const host = new URL(databaseUrl).hostname;

  process.stdout.write(
    `\nThis will DROP every table in the public schema of ${host}.\n` +
      'Everything in it is lost. The Supabase auth users are not affected.\n',
  );

  if (assumesYes) {
    process.stdout.write('Confirmation skipped because --yes was passed.\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Type the host (${host}) to continue: `);
    if (answer.trim() !== host) {
      throw new Error('Reset aborted: the confirmation did not match the host.');
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const target = resolveDatabaseTarget();
  const label = target.remote ? 'REMOTE' : 'local';

  if (target.remote) {
    await confirmRemoteReset(target.databaseUrl);
  }

  process.stdout.write(`Resetting the ${label} database.\n`);

  const sql = postgres(target.databaseUrl, { ...sslOptions(target.remote), max: 1 });

  try {
    const dropped = await dropPublicSchema(sql);
    process.stdout.write(
      dropped.length > 0
        ? `Dropped ${dropped.length} object(s): ${dropped.join(', ')}\n`
        : 'Nothing to drop; the public schema was already empty.\n',
    );
  } finally {
    await sql.end();
  }

  pushSchema();
  process.stdout.write('Schema applied from src/db/schema/.\n');

  // A freshly pushed schema is wide open: the `anon` role has full grants
  // and row level security is off. Lock it down before anything else runs.
  await lockDownSchema();

  if (wantsSeed) {
    // Imported after the schema is in place: the seed creates the Drizzle
    // client, which binds to DATABASE_URL when it is first loaded.
    const { seedJobHuntData } = await import('./seed-job-hunt');
    const seeded = await seedJobHuntData();
    process.stdout.write(`Seeded ${seeded.users} user(s) and ${seeded.profiles} profile(s).\n`);
  } else {
    process.stdout.write('No seed data inserted; the database is empty.\n');
  }

  process.stdout.write(
    '\nDone. The portfolio profile and content sections are not seeded by this ' +
      'script: run `pnpm run db:seed-portfolio` for those.\n',
  );
}

main()
  .then(() => {
    // The Drizzle client opened by the seed stays connected, which would
    // keep the process alive indefinitely.
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Reset failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
