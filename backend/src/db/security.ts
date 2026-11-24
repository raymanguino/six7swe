import type postgres from 'postgres';
import { isReservedRole } from './appRole';
import { isSafeIdentifier, quoteIdentifier } from './identifier';

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
 *   - Function execution is revoked, including the default privilege, for
 *     every routine by its full signature. A function in the `public` schema
 *     is an RPC endpoint for PostgREST, so one left executable would be
 *     callable by the public anon key. The default grants EXECUTE to
 *     `PUBLIC`, so it has to be revoked from `PUBLIC`; revoking it from
 *     `anon` alone would leave the grant in place for `anon` to inherit.
 *
 * A runtime role (`appRole.ts`) is let back in: SELECT, INSERT, UPDATE and
 * DELETE on tables, USAGE on sequences, one policy per table admitting only it,
 * and the same as default privileges for later tables. Without one (local
 * development) the backend is the owner, which bypasses RLS. The role comes
 * from the environment, so this file, not the Drizzle schema, holds these
 * rules and `db:secure` has to run after every migration.
 *
 * A previous runtime role is shut out when `DATABASE_URL` moves to a new one:
 * its table, sequence and schema grants, its default privileges and its LOGIN
 * are revoked. `db:secure` owns the owner's default privileges in `public`, so
 * a role that holds one and is neither the runtime role nor a role Postgres or
 * Supabase relies on is taken to be a former runtime role.
 */

/** Roles that reach the database from a browser. */
const PUBLIC_ROLES = ['anon', 'authenticated'] as const;

/** The role the migrations connect as, and the owner of the tables. */
export const OWNER_ROLE = 'postgres';

/** One fixed name, so a change of runtime role replaces the policy. */
export const APP_POLICY = 'backend_app_access';

const APP_TABLE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

const APP_SEQUENCE_PRIVILEGES = 'USAGE, SELECT';

/**
 * Matches a routine's argument types as `oidvectortypes` prints them
 * (`integer, character varying, text[]`). Double quotes are allowed for type
 * names that need them; parentheses, semicolons and string quotes are not, so
 * the list cannot close the signature or start another statement.
 */
const SAFE_ARGUMENT_TYPES = /^[A-Za-z0-9_ ,."[\]]*$/;

/** A routine in the `public` schema, addressed by its full signature. */
export interface PublicFunction {
  name: string;
  /** The argument types, comma separated; empty for none. */
  args: string;
}

/** The objects in `public` and the roles the lockdown applies to. */
export interface SecurityTargets {
  /** Table names in the `public` schema. */
  tables: string[];
  /** Sequence names in the `public` schema. */
  sequences?: string[];
  /** Every routine in the `public` schema, with its argument types. */
  functions?: PublicFunction[];
  /** The backend's runtime role, or null when it connects as the owner. */
  appRole?: string | null;
  /** Roles that were the runtime role before and are shut out now. */
  formerRoles?: string[];
}

/**
 * The signature a routine is revoked by. A function with arguments cannot be
 * addressed by name alone, and overloads share a name, so each is revoked by
 * its own signature.
 */
function functionSignature(fn: PublicFunction): string {
  if (!SAFE_ARGUMENT_TYPES.test(fn.args)) {
    throw new Error(`Unsafe SQL argument list for ${fn.name}: ${fn.args}`);
  }
  return `public.${quoteIdentifier(fn.name)}(${fn.args})`;
}

/**
 * Builds the statements that lock a set of tables down.
 *
 * Pure, so the rules can be asserted in a test without a database.
 */
export function buildSecurityStatements({
  tables,
  sequences = [],
  functions = [],
  appRole = null,
  formerRoles = [],
}: SecurityTargets): string[] {
  const statements: string[] = [];

  for (const table of tables) {
    const quoted = quoteIdentifier(table);

    // With RLS on, a role no policy names sees no rows. The only policy is the
    // runtime role's (`buildAppGrantStatements`), so every other role, and
    // every role when there is no runtime role, is denied every row.
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

  // ROUTINE covers functions, procedures and aggregates alike.
  for (const fn of functions) {
    const signature = functionSignature(fn);
    for (const role of PUBLIC_ROLES) {
      statements.push(`REVOKE ALL PRIVILEGES ON ROUTINE ${signature} FROM ${role};`);
    }
    // The default grants EXECUTE to PUBLIC, which `anon` inherits. Revoking
    // from the named roles alone would leave `anon` able to execute it.
    statements.push(`REVOKE ALL PRIVILEGES ON ROUTINE ${signature} FROM PUBLIC;`);
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

  for (const former of formerRoles) {
    if (former !== appRole) {
      statements.push(...buildFormerRoleStatements(former));
    }
  }

  if (appRole !== null) {
    statements.push(...buildAppGrantStatements(appRole, tables, sequences));
  }

  return statements;
}

/**
 * Shuts a previous runtime role out: no rows, no default privileges on later
 * tables, and no login. The role itself is kept (it may still own objects or
 * hold grants elsewhere), so dropping it stays an optional manual step.
 */
function buildFormerRoleStatements(formerRole: string): string[] {
  const role = quoteIdentifier(formerRole);
  if (formerRole === OWNER_ROLE) {
    throw new Error(`The table owner (${OWNER_ROLE}) cannot be shut out as a former role.`);
  }

  return [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public REVOKE ALL ON TABLES FROM ${role};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role};`,
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};`,
    `ALTER ROLE ${role} NOLOGIN;`,
  ];
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
 * Picks the former runtime roles out of the grantees of the owner's default
 * privileges in `public`. The owner, the current runtime role and the roles
 * Postgres or Supabase rely on are never former roles, and a name that is not
 * a plain identifier could never have been a runtime role.
 */
export function selectFormerRoles(grantees: string[], appRole: string | null): string[] {
  const former = grantees.filter(
    (role) =>
      role !== OWNER_ROLE && role !== appRole && isSafeIdentifier(role) && !isReservedRole(role),
  );
  return [...new Set(former)].sort();
}

/**
 * The tables, sequences and routines in the `public` schema, and the roles
 * the owner's default privileges there name.
 *
 * Only `public` is touched. The schemas Supabase manages (`auth`, `storage`,
 * `realtime`, `graphql`) are left alone.
 */
async function readPublicObjects(sql: postgres.TransactionSql): Promise<{
  tables: string[];
  sequences: string[];
  functions: PublicFunction[];
  defaultGrantees: string[];
}> {
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

  // Every routine with its argument types, so overloads and functions with
  // arguments are revoked too: PostgREST calls any of them by name.
  const functions = await sql<PublicFunction[]>`
    select p.proname as name, pg_catalog.oidvectortypes(p.proargtypes) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by 1, 2
  `;

  const grantees = await sql<{ rolname: string }[]>`
    select distinct r.rolname
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
    where d.defaclrole = (select oid from pg_roles where rolname = ${OWNER_ROLE}::name)
      and d.defaclnamespace = (select oid from pg_namespace where nspname = 'public')
    order by r.rolname
  `;

  return {
    tables: tables.map((row) => row.table_name),
    sequences: sequences.map((row) => row.sequence_name),
    functions: functions.map((row) => ({ name: row.name, args: row.args })),
    defaultGrantees: grantees.map((row) => row.rolname),
  };
}

export interface SecurityResult {
  /** The tables that were locked down. */
  tables: string[];
  /** The former runtime roles that were shut out. */
  formerRoles: string[];
  /** The statements that were applied. */
  statements: number;
}

/**
 * Locks the application tables down.
 *
 * Idempotent: running it again re-applies the same rules without failing.
 * It runs inside the caller's transaction, so a table is never left with RLS
 * on and the runtime role's policy dropped but not yet recreated.
 *
 * @param sql A transaction as the table owner.
 * @param appRole The backend's runtime role, or null when it connects as the
 *   owner.
 */
export async function applyDatabaseSecurity(
  sql: postgres.TransactionSql,
  appRole: string | null = null,
): Promise<SecurityResult> {
  const { tables, sequences, functions, defaultGrantees } = await readPublicObjects(sql);
  const formerRoles = selectFormerRoles(defaultGrantees, appRole);
  const statements = buildSecurityStatements({
    tables,
    sequences,
    functions,
    appRole,
    formerRoles,
  });

  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  return { tables, formerRoles, statements: statements.length };
}
