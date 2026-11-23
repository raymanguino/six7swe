import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type postgres from 'postgres';

/**
 * The backend's runtime database role.
 *
 * The backend runs a `--no-sandbox` Chrome for the job scraper, so anything
 * that can read the process environment could connect with `DATABASE_URL`.
 * That URL therefore names a role that can read and write the `public` tables
 * but owns none of them: no DDL, no `DROP`, `ALTER` or `TRUNCATE`. The tables
 * stay owned by the role in `DATABASE_MIGRATION_URL`, which only the
 * migration scripts use (`db:migrate`, `db:secure`, `db:reset`).
 *
 * `DATABASE_URL` is the source of truth for the role: `db:secure` reads its
 * user name and password and creates the role (or resets its password) over
 * the owner connection, so rotating the password is a change to one variable
 * followed by a deploy. The grants and row level security policies are in
 * `security.ts`.
 */

/** Matches an unquoted Postgres identifier. */
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

/** PBKDF2 iterations for the SCRAM verifier; Postgres's own default. */
const SCRAM_ITERATIONS = 4096;

/** The connection settings of the role a URL connects as. */
export interface RoleCredentials {
  /** The Postgres role name. */
  role: string;
  /** The password, decoded. Empty when the URL has none. */
  password: string;
}

/**
 * The role a connection string connects as.
 *
 * The Supabase pooler (Supavisor) takes the user name as `<role>.<project-ref>`
 * and connects as `<role>`, so anything after the first dot is dropped. A role
 * name that is not a plain lower-case identifier is rejected, because it is
 * interpolated into SQL.
 */
export function roleFromUrl(url: string): RoleCredentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The database URL is not a valid connection string.');
  }

  const user = decodeURIComponent(parsed.username);
  const role = user.split('.')[0] ?? '';
  if (!SAFE_ROLE.test(role)) {
    throw new Error(
      `The database URL's role "${role}" is not a plain lower-case identifier ([a-z_][a-z0-9_]*).`,
    );
  }

  return { role, password: decodeURIComponent(parsed.password) };
}

/**
 * The runtime role to provision, or null when the backend connects as the
 * owner (local development without `DATABASE_MIGRATION_URL`, where both URLs
 * are the same).
 *
 * @param ownerUrl The migration connection (`DATABASE_MIGRATION_URL`).
 * @param appUrl The backend's connection (`DATABASE_URL`).
 * @param ownerRole The role the lockdown's default privileges are written for.
 */
export function resolveRuntimeRole(
  ownerUrl: string,
  appUrl: string,
  ownerRole: string,
): RoleCredentials | null {
  const owner = roleFromUrl(ownerUrl);
  const app = roleFromUrl(appUrl);

  if (app.role === owner.role) {
    return null;
  }
  if (owner.role !== ownerRole) {
    throw new Error(
      `DATABASE_MIGRATION_URL must connect as ${ownerRole}, the owner of the tables, not ${owner.role}.`,
    );
  }
  if (!app.password) {
    throw new Error(
      `DATABASE_URL has no password. It is the password db:secure sets for the ${app.role} role.`,
    );
  }

  return app;
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password.
 *
 * Passing the verifier to `CREATE ROLE ... PASSWORD` instead of the plain
 * password means the password never appears in a statement, so it cannot end
 * up in a server log. Postgres recognises the `SCRAM-SHA-256$` prefix and
 * stores the value as is (RFC 5802 and RFC 7677).
 *
 * Postgres runs a password through SASLprep before hashing it. SASLprep leaves
 * printable ASCII unchanged, so only printable ASCII passwords are accepted:
 * anything else could hash differently here and in the server.
 *
 * @param salt Fixed only in tests; a random 16 bytes otherwise.
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
 * Builds the statements that create the runtime role or reset its password.
 *
 * Pure, so the rules can be asserted in a test without a database. The role is
 * created with the defaults (no superuser, no `CREATEDB`, no `CREATEROLE`, no
 * `BYPASSRLS`, no membership in any role); those attributes are not named,
 * because on Supabase the `postgres` role may not set them at all. Nothing
 * grants it `CREATE` on the `public` schema; `provisionAppRole` checks that.
 */
export function buildAppRoleStatements(role: string, verifier: string): string[] {
  if (!SAFE_ROLE.test(role)) {
    throw new Error(`Unsafe SQL identifier: ${role}`);
  }
  if (!/^SCRAM-SHA-256\$[A-Za-z0-9+/=:$]+$/.test(verifier)) {
    throw new Error('The password verifier is not a SCRAM-SHA-256 verifier.');
  }

  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN; END IF; END $$;`,
    `ALTER ROLE "${role}" WITH LOGIN PASSWORD '${verifier}';`,
  ];
}

/** The catalog facts that decide whether a role is safe as the runtime role. */
interface RoleCheckRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  owner_member: boolean;
  owns_tables: boolean;
  can_create: boolean;
}

/**
 * Explains what is wrong with a role as the runtime role, or returns an empty
 * list. A role that bypasses row level security, can act as the table owner
 * or owns a table would put the owner's rights back behind `DATABASE_URL`.
 */
export function describeRoleProblems(role: string, ownerRole: string, row: RoleCheckRow): string[] {
  const problems: string[] = [];
  if (row.rolsuper) problems.push(`${role} is a superuser`);
  if (row.rolbypassrls) problems.push(`${role} bypasses row level security`);
  if (row.rolcreaterole) problems.push(`${role} can create roles`);
  if (row.rolcreatedb) problems.push(`${role} can create databases`);
  if (row.owner_member) problems.push(`${role} is a member of ${ownerRole}`);
  if (row.owns_tables) problems.push(`${role} owns tables in the public schema`);
  if (row.can_create) problems.push(`${role} can create objects in the public schema`);
  return problems;
}

/**
 * Creates the runtime role or resets its password, then checks it holds none
 * of the owner's rights. Throws when it does, so a deploy fails rather than
 * run the backend with owner rights under a different name.
 *
 * @param sql A connection as the table owner.
 */
export async function provisionAppRole(
  sql: postgres.Sql,
  app: RoleCredentials,
  ownerRole: string,
): Promise<void> {
  for (const statement of buildAppRoleStatements(app.role, scramSha256Verifier(app.password))) {
    await sql.unsafe(statement);
  }

  const [row] = await sql<RoleCheckRow[]>`
    select
      r.rolsuper,
      r.rolbypassrls,
      r.rolcreaterole,
      r.rolcreatedb,
      pg_has_role(r.rolname, ${ownerRole}, 'MEMBER') as owner_member,
      exists (
        select 1 from pg_tables t
        where t.schemaname = 'public' and t.tableowner = r.rolname
      ) as owns_tables,
      has_schema_privilege(r.rolname, 'public', 'CREATE') as can_create
    from pg_roles r
    where r.rolname = ${app.role}
  `;

  if (!row) {
    throw new Error(`The role ${app.role} was not created.`);
  }

  const problems = describeRoleProblems(app.role, ownerRole, row);
  if (problems.length > 0) {
    throw new Error(
      `The runtime role must not hold the table owner's rights: ${problems.join('; ')}.`,
    );
  }
}
