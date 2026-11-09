import type postgres from 'postgres';

/**
 * Database access lockdown.
 *
 * Supabase grants the `anon` and `authenticated` roles full privileges on
 * every table in the `public` schema, and row level security is off unless
 * it is turned on. The frontend ships the anon key in the JavaScript bundle,
 * so with the default grants anybody could read `portfolio_profile` (the
 * resume, the email address and the phone number) over the REST API without
 * authenticating, and could write to the job-hunter tables as well.
 *
 * This module locks the application tables down:
 *
 *   - Row level security is enabled. A table with RLS on and no policies
 *     denies every row to every role that does not bypass RLS.
 *   - The `anon` and `authenticated` grants are revoked, so the REST API
 *     cannot reach the tables even if a policy were ever added by mistake.
 *   - The default privileges are revoked too. A table created later by
 *     `drizzle-kit push` would otherwise inherit the grants again.
 *   - Function execution is revoked, including the default privilege. A
 *     function in the `public` schema is an RPC endpoint for PostgREST, so
 *     one left executable would be callable by the public anon key. The
 *     default grants EXECUTE to `PUBLIC`, so it has to be revoked from
 *     `PUBLIC`; revoking it from `anon` alone would leave the grant in
 *     place for `anon` to inherit.
 *
 * The backend is unaffected: it connects as the table owner, and an owner
 * bypasses RLS.
 *
 * The Drizzle schema cannot express any of this. Drizzle ORM 0.33 has no
 * policy or role support, so this file is the source of truth for the
 * database's access rules and `db:secure` has to run after every push.
 */

/** Roles that reach the database from a browser. */
const PUBLIC_ROLES = ['anon', 'authenticated'] as const;

/** The role the Drizzle client connects as, and the owner of the tables. */
const OWNER_ROLE = 'postgres';

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
 */
export function buildSecurityStatements(
  tables: string[],
  sequences: string[] = [],
  functions: string[] = [],
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
 */
export async function applyDatabaseSecurity(sql: postgres.Sql): Promise<SecurityResult> {
  const { tables, sequences, functions } = await readPublicObjects(sql);
  const statements = buildSecurityStatements(tables, sequences, functions);

  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  return { tables, statements: statements.length };
}
