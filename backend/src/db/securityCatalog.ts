import type postgres from 'postgres';
import { isReservedRole, RUNTIME_ROLE_MARKER } from './appRole';
import { isSafeIdentifier } from './identifier';
import { type PublicFunction, type PublicObjects } from './lockdownStatements';
import { OWNER_ROLE } from './security';

/**
 * The catalog reads behind the lockdown in `security.ts`. Only `public` is
 * read; the schemas Supabase manages (`auth`, `storage`, `realtime`,
 * `graphql`) are left alone.
 */

/** A routine in `public` that `db:secure` cannot revoke, reported instead. */
export interface SkippedFunction {
  /** The full signature, as Postgres prints it. */
  signature: string;
  owner: string;
  /** The extension it belongs to, or null. */
  extension: string | null;
  definer: boolean;
}

export interface CatalogObjects extends PublicObjects {
  skippedFunctions: SkippedFunction[];
}

interface RoutineRow extends PublicFunction {
  signature: string;
  owner: string;
  extension: string | null;
  definer: boolean;
  managed: boolean;
}

/** The tables, sequences and routines in `public`. */
export async function readPublicObjects(sql: postgres.TransactionSql): Promise<CatalogObjects> {
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
  const routines = await sql<RoutineRow[]>`
    select p.proname as name, pg_catalog.oidvectortypes(p.proargtypes) as args,
      p.oid::regprocedure::text as signature, pg_get_userbyid(p.proowner) as owner,
      (select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
        limit 1) as extension,
      p.prosecdef as definer,
      -- Managed: the owner's and not an extension's, so the owner can revoke it.
      (p.proowner = ${OWNER_ROLE}::regrole and not exists (select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) as managed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by 1, 2
  `;

  return {
    tables: tables.map((row) => row.table_name),
    sequences: sequences.map((row) => row.sequence_name),
    functions: routines.filter((row) => row.managed).map(({ name, args }) => ({ name, args })),
    skippedFunctions: routines
      .filter((row) => !row.managed)
      .map(({ signature, owner, extension, definer }) => ({
        signature,
        owner,
        extension,
        definer,
      })),
  };
}

/**
 * Picks the former runtime roles out of the marked roles. The owner, the
 * current runtime role and the roles Postgres or Supabase rely on never are,
 * and a name that is not a plain identifier could never have been one.
 */
export function selectFormerRoles(marked: string[], appRole: string | null): string[] {
  const former = marked.filter(
    (role) =>
      role !== OWNER_ROLE && role !== appRole && isSafeIdentifier(role) && !isReservedRole(role),
  );
  return [...new Set(former)].sort();
}

/** The roles marked as this database's runtime role, other than the current one. */
export async function readFormerRoles(
  sql: postgres.TransactionSql,
  appRole: string | null,
): Promise<string[]> {
  const marked = await sql<{ rolname: string }[]>`
    select rolname from pg_roles
    where shobj_description(oid, 'pg_authid') = ${RUNTIME_ROLE_MARKER} || ':' || current_database()
  `;
  return selectFormerRoles(
    marked.map((row) => row.rolname),
    appRole,
  );
}

/**
 * The SECURITY DEFINER routines in `public`, managed or not, that `anon`,
 * `authenticated` or `PUBLIC` can still execute, each with the REVOKE its
 * owner has to run; empty when none can. Such a routine runs with its owner's
 * rights for whoever holds the anon key.
 */
export async function readExposedDefinerRoutines(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ signature: string; owner: string; roles: string }[]>`
    select format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
        as signature, pg_get_userbyid(p.proowner) as owner,
      concat_ws(', ',
      case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' end,
      case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated' end,
      case when exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ) then 'PUBLIC' end) as roles
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
    order by 1
  `;
  return rows
    .filter((row) => row.roles !== '')
    .map(
      (row) =>
        `${row.signature} (owner ${row.owner}; executable by ${row.roles}): as ${row.owner}, run ` +
        `REVOKE EXECUTE ON FUNCTION ${row.signature} FROM ${row.roles};`,
    );
}

/**
 * Ends the sessions of roles that were just shut out, so a connection opened
 * before the NOLOGIN does not keep working. Best effort: a session the owner
 * may not signal is left alone.
 *
 * @returns The number of sessions ended.
 */
export async function terminateRoleSessions(sql: postgres.Sql, roles: string[]): Promise<number> {
  if (roles.length === 0) {
    return 0;
  }
  const sessions = await sql<{ pid: number }[]>`
    select pid from pg_stat_activity where usename = any(${roles}::name[])
  `;
  let ended = 0;
  for (const { pid } of sessions) {
    try {
      const [row] = await sql<{ ended: boolean }[]>`select pg_terminate_backend(${pid}) as ended`;
      ended += row?.ended ? 1 : 0;
    } catch {
      // Not permitted (no pg_signal_backend): leave it; it can no longer log in.
    }
  }
  return ended;
}
