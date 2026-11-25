import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { isSafeIdentifier, quoteIdentifier } from './identifier';

/**
 * The backend's runtime database role.
 *
 * The backend runs a `--no-sandbox` Chrome for the job scraper, so anything
 * that can read the process environment could connect with `DATABASE_URL`.
 * That URL therefore names a role that can read and write the `public` tables
 * but owns nothing: no DDL, no `DROP`, `ALTER` or `TRUNCATE`. The tables stay
 * owned by the role in `DATABASE_MIGRATION_URL`, which only the migration
 * scripts use.
 *
 * `DATABASE_URL` is the source of truth for the role: `db:secure` creates it
 * (or resets its password) from the URL's user and password over the owner
 * connection. The grants and policies are in `security.ts`.
 */

/** Roles Postgres or Supabase rely on, which must never become the runtime role. */
const RESERVED_ROLE =
  /^(pg_|supabase_|pgsodium)|^(postgres|anon|authenticated|service_role|authenticator|dashboard_user|pgbouncer|cli_login_postgres)$/;

/**
 * The comment `db:secure` puts on the runtime role, followed by `:` and the
 * database name: roles are cluster-wide, so the marker says which database's
 * runtime role it is. A role marked for this database that is no longer its
 * runtime role is shut out (`lockdownStatements.ts`); no other role is.
 */
export const RUNTIME_ROLE_MARKER = 'six7swe-runtime';

/** True for a role Postgres or Supabase relies on, which `db:secure` never manages. */
export function isReservedRole(role: string): boolean {
  return RESERVED_ROLE.test(role);
}

/** The shortest runtime role password accepted (`openssl rand -hex 32` gives 64). */
export const MIN_APP_PASSWORD_LENGTH = 32;

/** PBKDF2 iterations for the SCRAM verifier; Postgres's own default. */
const SCRAM_ITERATIONS = 4096;

/** The connection settings of the role a URL connects as. */
export interface RoleCredentials {
  role: string;
  /** Decoded; empty when the URL has none. */
  password: string;
}

/**
 * The role a connection string connects as. The Supabase pooler takes the user
 * as `<role>.<project-ref>`, so anything after the first dot is dropped. The
 * URL is never echoed in an error: it holds a password.
 */
export function roleFromUrl(url: string): RoleCredentials {
  let user: string;
  let password: string;
  try {
    const parsed = new URL(url);
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error('The database URL is not a valid connection string.');
  }

  const role = user.split('.')[0] ?? '';
  if (!isSafeIdentifier(role)) {
    throw new Error("The database URL's role is not a plain lower-case identifier.");
  }
  return { role, password };
}

/**
 * The runtime role to provision, or null when the backend connects as the
 * owner. That is allowed only locally (`strict` false): with `strict`, a
 * missing or owner-named runtime role is an error, so a deploy cannot quietly
 * run the server with owner rights. Everything is validated before any SQL runs.
 *
 * @param ownerUrl `DATABASE_MIGRATION_URL`, or `DATABASE_URL` when unset.
 * @param appUrl `DATABASE_URL`.
 */
export function resolveRuntimeRole(
  ownerUrl: string,
  appUrl: string,
  ownerRole: string,
  strict: boolean,
): RoleCredentials | null {
  const owner = roleFromUrl(ownerUrl);
  const app = roleFromUrl(appUrl);

  if (app.role === owner.role) {
    if (strict) {
      throw new Error(
        'DATABASE_URL must name a runtime role other than the owner in DATABASE_MIGRATION_URL.',
      );
    }
    return null;
  }
  if (owner.role !== ownerRole) {
    throw new Error(`DATABASE_MIGRATION_URL must connect as ${ownerRole}, not ${owner.role}.`);
  }
  if (isReservedRole(app.role)) {
    throw new Error(`DATABASE_URL names the reserved role ${app.role}; pick a role of its own.`);
  }
  if (app.password.length < MIN_APP_PASSWORD_LENGTH) {
    throw new Error(
      `DATABASE_URL's password must be at least ${MIN_APP_PASSWORD_LENGTH} characters ` +
        '(openssl rand -hex 32).',
    );
  }
  return app;
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802, 7677).
 * Postgres stores a value with this prefix as is, so the plain password never
 * appears in a statement or a server log. Only printable ASCII is accepted,
 * which SASLprep leaves unchanged, so the server hashes it the same way.
 *
 * @param salt Fixed only in tests.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new Error('The database password must be non-empty printable ASCII.');
  }

  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();

  return (
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

/**
 * The statements that create the runtime role or reset its password. The role
 * gets the defaults (no superuser, CREATEDB, CREATEROLE, BYPASSRLS or
 * membership); they are not named because Supabase's `postgres` may not set
 * them. `readRoleProblems` checks the result.
 */
export function buildAppRoleStatements(
  role: string,
  verifier: string,
  marker: string = RUNTIME_ROLE_MARKER,
): string[] {
  const quoted = quoteIdentifier(role);
  if (!/^SCRAM-SHA-256\$[A-Za-z0-9+/=:$]+$/.test(verifier)) {
    throw new Error('The password verifier is not a SCRAM-SHA-256 verifier.');
  }

  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${quoted} LOGIN; END IF; END $$;`,
    // Mark it for this database, refusing a role whose comment says it is something else.
    `DO $$ DECLARE m text := '${marker}:' || current_database();
      c text := shobj_description('${quoted}'::regrole, 'pg_authid');
    BEGIN IF c IS DISTINCT FROM m AND c IS NOT NULL THEN
      RAISE EXCEPTION 'Role ${role} has the comment "%", not "%"; refusing to adopt it.', c, m;
    END IF; EXECUTE format('COMMENT ON ROLE %I IS %L', '${role}', m); END $$;`,
    `ALTER ROLE ${quoted} WITH LOGIN PASSWORD '${verifier}';`,
  ];
}

/** The catalog facts that decide whether a role is safe as the runtime role. */
export interface RoleCheckRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  owner_member: boolean;
  member_of_any: boolean;
  owns_objects: boolean;
  can_create: boolean;
  executes_definer: boolean;
}

/**
 * What is wrong with a role as the runtime role; empty when nothing is. Any of
 * these would put the owner's rights, or a way to them, behind `DATABASE_URL`.
 */
export function describeRoleProblems(role: string, ownerRole: string, row: RoleCheckRow): string[] {
  const checks: [boolean, string][] = [
    [row.rolsuper, 'is a superuser'],
    [row.rolbypassrls, 'bypasses row level security'],
    [row.rolcreaterole, 'can create roles'],
    [row.rolcreatedb, 'can create databases'],
    [row.rolreplication, 'can start replication'],
    [row.owner_member, `is a member of ${ownerRole}`],
    [row.member_of_any, 'is a member of another role'],
    [row.owns_objects, 'owns objects in the public schema'],
    [row.can_create, 'can create objects in the public schema'],
    // A SECURITY DEFINER function runs with its owner's rights, so being able
    // to call one is a way to the owner's rights.
    [row.executes_definer, 'can execute a SECURITY DEFINER function in the public schema'],
  ];
  return checks.filter(([bad]) => bad).map(([, problem]) => `${role} ${problem}`);
}

/** Reads a role's catalog facts and describes what is wrong with it. */
export async function readRoleProblems(
  sql: postgres.TransactionSql,
  role: string,
  ownerRole: string,
): Promise<string[]> {
  const [row] = await sql<RoleCheckRow[]>`
    select
      r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      pg_has_role(r.rolname, ${ownerRole}::name, 'MEMBER') as owner_member,
      exists (select 1 from pg_auth_members m where m.member = r.oid) as member_of_any,
      -- Every owned object of any kind (table, type, enum, function, operator ...) has an
      -- ownership row in pg_shdepend, so this covers all catalogs rather than listing them.
      exists (
        select 1 from pg_shdepend d
        cross join lateral pg_identify_object(d.classid, d.objid, d.objsubid) o
        where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o'
          and d.dbid = (select oid from pg_database where datname = current_database())
          and (o.schema = 'public' or (o.type = 'schema' and o.identity = 'public'))
      ) as owns_objects,
      has_schema_privilege(r.rolname, 'public', 'CREATE') as can_create,
      exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and has_function_privilege(r.oid, p.oid, 'EXECUTE')
      ) as executes_definer
    from pg_roles r
    where r.rolname = ${role}::name
  `;
  return row ? describeRoleProblems(role, ownerRole, row) : [`${role} does not exist`];
}

/**
 * Creates the runtime role or resets its password. Runs inside the lockdown's
 * transaction; `assertAppRoleIsSafe` checks the role once the grants are in
 * place, and a failed check rolls the role and the password change back.
 *
 * @param sql A transaction as the table owner.
 */
export async function provisionAppRole(
  sql: postgres.TransactionSql,
  app: RoleCredentials,
  marker: string = RUNTIME_ROLE_MARKER,
): Promise<void> {
  const statements = buildAppRoleStatements(app.role, scramSha256Verifier(app.password), marker);
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

/**
 * Throws when the runtime role holds owner rights or a way to them, so the
 * deploy fails rather than run the backend with them. Runs after the lockdown,
 * whose function revokes are what take a SECURITY DEFINER function out of reach.
 */
export async function assertAppRoleIsSafe(
  sql: postgres.TransactionSql,
  role: string,
  ownerRole: string,
): Promise<void> {
  const problems = await readRoleProblems(sql, role, ownerRole);
  if (problems.length > 0) {
    throw new Error(`The runtime role must not hold owner rights: ${problems.join('; ')}.`);
  }
}

/**
 * Refuses to serve when the server's own connection holds owner rights. Run at
 * production startup, so a `DATABASE_URL` pointed back at the owner fails the
 * deploy instead of silently undoing the runtime role.
 */
export async function assertRuntimeRoleIsSafe(sql: postgres.Sql, ownerRole: string): Promise<void> {
  const problems = await sql.begin(async (tx) => {
    const [current] = await tx<{ role: string }[]>`select current_user as role`;
    return readRoleProblems(tx, current?.role ?? '', ownerRole);
  });
  if (problems.length > 0) {
    throw new Error(`DATABASE_URL must connect as a non-owner role: ${problems.join('; ')}.`);
  }
}
