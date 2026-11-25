/**
 * Resolves the database connection settings for the maintenance scripts.
 *
 * The database URL is chosen before anything imports `src/db`, because that
 * module reads DATABASE_URL when it is first loaded and creates the client
 * right away. The scripts therefore resolve the URL here and pass it around
 * explicitly rather than relying on import order.
 */

import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import path from 'node:path';
import { roleFromUrl } from '../src/db/appRole';

export interface DatabaseTarget {
  /**
   * The connection as the table owner, for migrations and the lockdown:
   * `DATABASE_MIGRATION_URL`, or `DATABASE_URL` when that is unset.
   */
  databaseUrl: string;
  /**
   * The backend's runtime connection, `DATABASE_URL`. `db:secure` provisions
   * its role when it differs from the owner's (see src/db/appRole.ts).
   */
  appDatabaseUrl: string;
  /**
   * The scraper worker's connection, `DATABASE_WORKER_URL`; undefined when no
   * worker is deployed. `db:secure` provisions its role (src/db/workerRole.ts).
   */
  workerDatabaseUrl: string | undefined;
  /** True when the hosted database was selected. */
  remote: boolean;
  /** True when the backend must run as a separate runtime role (remote or production). */
  strict: boolean;
}

/** True when the script was asked to target the hosted database. */
export const wantsRemote = process.argv.includes('--remote');

/**
 * True when the caller asked for the job-hunt development data to be
 * inserted. A reset leaves the database empty unless this is passed.
 */
export const wantsSeed = process.argv.includes('--seed');

/**
 * True when the caller confirmed a destructive operation up front, so the
 * script does not have to ask.
 */
export const assumesYes = process.argv.includes('--yes');

/**
 * Loads the env file for the selected target and returns the connection.
 *
 * `.env` points at the local Supabase stack; `.env.remote` points at the
 * hosted project. Values already in the environment win over both, so a
 * caller can override the URL without editing a file.
 *
 * The migrations connect as the table owner through `DATABASE_MIGRATION_URL`.
 * Without it, and only locally, they use `DATABASE_URL`: the local stack's
 * `postgres` user owns the tables and the backend connects as it too.
 */
export function resolveDatabaseTarget(): DatabaseTarget {
  const envFile = wantsRemote ? '.env.remote' : '.env';
  dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

  const appDatabaseUrl = process.env.DATABASE_URL;

  if (!appDatabaseUrl) {
    throw new Error(
      `DATABASE_URL is not set. Add it to backend/${envFile} or export it before running this script.`,
    );
  }

  // The fallback is for local development only: the hosted database and the
  // production image must never run the backend as the owner.
  const strict = wantsRemote || process.env.NODE_ENV === 'production';
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (strict && !migrationUrl) {
    throw new Error(
      `DATABASE_MIGRATION_URL is not set. With --remote or NODE_ENV=production it is required (backend/${envFile}).`,
    );
  }
  if (
    strict &&
    migrationUrl &&
    roleFromUrl(migrationUrl).role === roleFromUrl(appDatabaseUrl).role
  ) {
    throw new Error('DATABASE_URL must name a runtime role other than DATABASE_MIGRATION_URL.');
  }

  return {
    databaseUrl: migrationUrl || appDatabaseUrl,
    appDatabaseUrl,
    workerDatabaseUrl: process.env.DATABASE_WORKER_URL || undefined,
    remote: wantsRemote,
    strict,
  };
}

/** The SSL settings postgres.js needs for a hosted connection. */
export function sslOptions(remote: boolean): { ssl: 'require' } | { ssl: undefined } {
  return remote ? { ssl: 'require' } : { ssl: undefined };
}

/**
 * Applies the pending migrations to the selected target.
 *
 * The owner connection is passed through explicitly rather than relying on the
 * environment: dotenv does not override a variable that is already set, so
 * the local .env would otherwise win over the --remote target.
 */
export function runMigrations(target: DatabaseTarget): void {
  const result = spawnSync('npx', ['drizzle-kit', 'migrate'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    // Both names carry the owner connection: drizzle.config.ts prefers
    // DATABASE_MIGRATION_URL, and an inherited one must not point elsewhere.
    env: {
      ...process.env,
      DATABASE_URL: target.databaseUrl,
      DATABASE_MIGRATION_URL: target.databaseUrl,
    },
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`drizzle-kit migrate failed with exit code ${result.status ?? 'unknown'}`);
  }
}
