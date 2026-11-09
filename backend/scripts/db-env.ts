/**
 * Resolves the database connection settings for the maintenance scripts.
 *
 * The database URL is chosen before anything imports `src/db`, because that
 * module reads DATABASE_URL when it is first loaded and creates the client
 * right away. The scripts therefore resolve the URL here and pass it around
 * explicitly rather than relying on import order.
 */

import dotenv from 'dotenv';
import path from 'node:path';

export interface DatabaseTarget {
  /** The connection string. */
  databaseUrl: string;
  /** True when the hosted database was selected. */
  remote: boolean;
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
 */
export function resolveDatabaseTarget(): DatabaseTarget {
  const envFile = wantsRemote ? '.env.remote' : '.env';
  dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL is not set. Add it to backend/${envFile} or export it before running this script.`,
    );
  }

  return { databaseUrl, remote: wantsRemote };
}

/** The SSL settings postgres.js needs for a hosted connection. */
export function sslOptions(remote: boolean): { ssl: 'require' } | { ssl: undefined } {
  return remote ? { ssl: 'require' } : { ssl: undefined };
}
