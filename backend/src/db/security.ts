/**
 * Database access lockdown.
 *
 * Supabase grants the `anon` and `authenticated` roles full privileges on
 * every table in the `public` schema, and row level security is off unless
 * it is turned on. The frontend ships the anon key in the JavaScript bundle,
 * so with the default grants anybody could read and write the job-hunter
 * tables (users and their email addresses, search profiles, matches) over the
 * REST API without authenticating.
 *
 * This module locks the application tables down:
 *
 *   - Row level security is enabled. A table with RLS on and no policies
 *     denies every row to every role that does not bypass RLS.
 *   - The `anon` and `authenticated` grants are revoked, so the REST API
 *     cannot reach the tables even if a policy were ever added by mistake.
 *   - The default privileges are revoked too. A table created later by
 *     `drizzle-kit migrate` would otherwise inherit the grants again.
 *   - Function execution is revoked, including the default privilege. A
 *     function in the `public` schema is an RPC endpoint for PostgREST, so
 *     one left executable would be callable by the public anon key. The
 *     default grants EXECUTE to `PUBLIC`, so it has to be revoked from
 *     `PUBLIC`; revoking it from `anon` alone would leave the grant in
 *     place for `anon` to inherit.
 *
 * A runtime role (`appRole.ts`) is let back in: SELECT, INSERT, UPDATE and
 * DELETE on tables, USAGE on sequences, one policy per table admitting only it,
 * and the same as default privileges for later tables. Without one (local
 * development) the backend is the owner, which bypasses RLS. The role comes
 * from the environment, so this file, not the Drizzle schema, holds these
 * rules and `db:secure` has to run after every migration.
 */

/** The role the migrations connect as, and the owner of the tables. */
export const OWNER_ROLE = 'postgres';

/** One fixed name, so a change of runtime role replaces the policy. */
export const APP_POLICY = 'backend_app_access';
