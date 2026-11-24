import type postgres from 'postgres';

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

/** Roles that reach the database from a browser. */
const PUBLIC_ROLES = ['anon', 'authenticated'] as const;

/** The role the migrations connect as, and the owner of the tables. */
export const OWNER_ROLE = 'postgres';

/** One fixed name, so a change of runtime role replaces the policy. */
export const APP_POLICY = 'backend_app_access';

const APP_TABLE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

const APP_SEQUENCE_PRIVILEGES = 'USAGE, SELECT';

/** Matches an unquoted Postgres identifier. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Quotes an identifier for use in a statement.
 *
 * The names come from the catalog, but they are still interpolated into SQL,
 * so anything that is not a plain identifier is rejected rather than escaped.
 */
function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Builds the statements that lock a set of tables down.
 *
 * Pure, so the rules can be asserted in a test without a database.
 *
 * @param tables Table names in the `public` schema.
 * @param sequences Sequence names in the `public` schema.
 * @param functions Function names in the `public` schema.
 * @param appRole The backend's runtime role, or null when it connects as the
 *   owner.
 */
export function buildSecurityStatements(
  tables: string[],
  sequences: string[] = [],
  functions: string[] = [],
  appRole: string | null = null,
): string[] {
  const statements: string[] = [];

  for (const table of tables) {
    const quoted = quoteIdentifier(table);

    // No policies are created, so the default is to deny every row.
    statements.push(`ALTER TABLE public.${quoted} ENABLE ROW LEVEL SECURITY;`);

    for (const role of PUBLIC_ROLES) {
      statements.push(`REVOKE ALL PRIVILEGES ON TABLE public.${quoted} FROM ${role};`);
    }
  }

  for (const sequence of sequences) {
    const quoted = quoteIdentifier(sequence);
    for (const role of PUBLIC_ROLES) {
      statements.push(`REVOKE ALL PRIVILEGES ON SEQUENCE public.${quoted} FROM ${role};`);
    }
  }

  for (const fn of functions) {
    const quoted = quoteIdentifier(fn);
    for (const role of PUBLIC_ROLES) {
      statements.push(`REVOKE ALL PRIVILEGES ON FUNCTION public.${quoted} FROM ${role};`);
    }
    // The default grants EXECUTE to PUBLIC, which `anon` inherits. Revoking
    // from the named roles alone would leave `anon` able to execute it.
    statements.push(`REVOKE ALL PRIVILEGES ON FUNCTION public.${quoted} FROM PUBLIC;`);
  }

  // A table created after this runs must not inherit the grants back.
  for (const role of PUBLIC_ROLES) {
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public REVOKE ALL ON TABLES FROM ${role};`,
    );
    statements.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role};`,
    );
  }

  // The default grants EXECUTE on functions to PUBLIC, and `anon` inherits
  // that. Revoking it from the named roles alone would leave a new function
  // callable, so PUBLIC has to be revoked too.
  //
  // This has to be the *global* form. The schema-scoped form leaves the
  // PUBLIC grant in place, because the global default is the one that
  // supplies the built-in EXECUTE privilege for a new function.
  statements.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  );

  if (appRole !== null) {
    statements.push(...buildAppGrantStatements(appRole, tables, sequences));
  }

  return statements;
}

/**
 * The grants and policies that let the runtime role read and write the rows.
 *
 * Runs after the lockdown, so revoking from the public roles never touches
 * them. The table grants are revoked first so a privilege granted by hand
 * (TRUNCATE, say) does not survive.
 */
function buildAppGrantStatements(appRole: string, tables: string[], sequences: string[]): string[] {
  const role = quoteIdentifier(appRole);
  if (appRole === OWNER_ROLE) {
    throw new Error(`The runtime role cannot be the table owner (${OWNER_ROLE}).`);
  }

  const statements = [`GRANT USAGE ON SCHEMA public TO ${role};`];

  for (const table of tables) {
    const quoted = quoteIdentifier(table);
    statements.push(`REVOKE ALL PRIVILEGES ON TABLE public.${quoted} FROM ${role};`);
    statements.push(`GRANT ${APP_TABLE_PRIVILEGES} ON TABLE public.${quoted} TO ${role};`);
    statements.push(`DROP POLICY IF EXISTS ${APP_POLICY} ON public.${quoted};`);
    statements.push(
      `CREATE POLICY ${APP_POLICY} ON public.${quoted} FOR ALL TO ${role} USING (true) WITH CHECK (true);`,
    );
  }

  for (const sequence of sequences) {
    const quoted = quoteIdentifier(sequence);
    statements.push(`GRANT ${APP_SEQUENCE_PRIVILEGES} ON SEQUENCE public.${quoted} TO ${role};`);
  }

  statements.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT ${APP_TABLE_PRIVILEGES} ON TABLES TO ${role};`,
  );
  statements.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT ${APP_SEQUENCE_PRIVILEGES} ON SEQUENCES TO ${role};`,
  );

  return statements;
}

/**
 * The tables, sequences and functions in the `public` schema.
 *
 * Only `public` is touched. The schemas Supabase manages (`auth`, `storage`,
 * `realtime`, `graphql`) are left alone.
 */
async function readPublicObjects(
  sql: postgres.Sql,
): Promise<{ tables: string[]; sequences: string[]; functions: string[] }> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `;

  const sequences = await sql<{ sequence_name: string }[]>`
    select sequence_name from information_schema.sequences
    where sequence_schema = 'public'
    order by sequence_name
  `;

  // Only plain functions are revoked by name. A function with arguments
  // cannot be addressed without its signature, and PostgREST addresses
  // functions by name, so the name is what matters here.
  const functions = await sql<{ proname: string }[]>`
    select p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.pronargs = 0
    group by p.proname
    order by p.proname
  `;

  return {
    tables: tables.map((row) => row.table_name),
    sequences: sequences.map((row) => row.sequence_name),
    functions: functions.map((row) => row.proname),
  };
}

export interface SecurityResult {
  /** The tables that were locked down. */
  tables: string[];
  /** The statements that were applied. */
  statements: number;
}

/**
 * Locks the application tables down.
 *
 * Idempotent: running it again re-applies the same rules without failing.
 * The statements run in one transaction, so a table is never left with RLS
 * on and the runtime role's policy dropped but not yet recreated.
 *
 * @param sql A connection as the table owner.
 * @param appRole The backend's runtime role, or null when it connects as the
 *   owner.
 */
export async function applyDatabaseSecurity(
  sql: postgres.Sql,
  appRole: string | null = null,
): Promise<SecurityResult> {
  const { tables, sequences, functions } = await readPublicObjects(sql);
  const statements = buildSecurityStatements(tables, sequences, functions, appRole);

  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
  });

  return { tables, statements: statements.length };
}
