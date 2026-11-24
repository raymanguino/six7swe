import { quoteIdentifier } from './identifier';
import { APP_POLICY, OWNER_ROLE } from './security';

/**
 * The statements behind the rules in `security.ts`, applied by
 * `scripts/db-lockdown.ts` in two transactions. Pure, so the rules can be
 * asserted in a test without a database. Each kind of object is revoked or
 * granted in one list statement; an empty list issues none.
 */

/** Roles that reach the database from a browser. */
const BROWSER_ROLES = 'anon, authenticated';

const APP_TABLE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

const APP_SEQUENCE_PRIVILEGES = 'USAGE, SELECT';

/**
 * Matches a routine's argument types as `oidvectortypes` prints them
 * (`integer, character varying, text[]`). Parentheses, semicolons and string
 * quotes are rejected, so the list cannot close the signature.
 */
const SAFE_ARGUMENT_TYPES = /^[A-Za-z0-9_ ,."[\]]*$/;

/** A routine in the `public` schema, addressed by its full signature. */
export interface PublicFunction {
  name: string;
  /** The argument types, comma separated; empty for none. */
  args: string;
}

/** The `public` objects the lockdown applies to. */
export interface PublicObjects {
  tables: string[];
  sequences: string[];
  /** The routines the owner can revoke (owned by it, not part of an extension). */
  functions: PublicFunction[];
}

/** A routine's full signature; overloads share a name, so the name alone is not enough. */
export function functionSignature(fn: PublicFunction): string {
  if (!SAFE_ARGUMENT_TYPES.test(fn.args)) {
    throw new Error(`Unsafe SQL argument list for ${fn.name}: ${fn.args}`);
  }
  return `public.${quoteIdentifier(fn.name)}(${fn.args})`;
}

/** A comma-separated list of `public` objects. */
function objectList(names: string[]): string {
  return names.map((name) => `public.${quoteIdentifier(name)}`).join(', ');
}

/** One `ALTER DEFAULT PRIVILEGES` per kind, for what the owner creates in `public` later. */
function defaultPrivileges(change: (kind: 'TABLES' | 'SEQUENCES') => string): string[] {
  return (['TABLES', 'SEQUENCES'] as const).map(
    (kind) => `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public ${change(kind)};`,
  );
}

/**
 * The statements that close `public` to the browser roles. Committed on their
 * own, so nothing that happens to the runtime role afterwards can undo them.
 */
export function buildLockdownStatements({ tables, sequences, functions }: PublicObjects): string[] {
  const statements = tables.map(
    (table) => `ALTER TABLE public.${quoteIdentifier(table)} ENABLE ROW LEVEL SECURITY;`,
  );

  if (tables.length > 0) {
    statements.push(`REVOKE ALL PRIVILEGES ON TABLE ${objectList(tables)} FROM ${BROWSER_ROLES};`);
  }
  if (sequences.length > 0) {
    statements.push(
      `REVOKE ALL PRIVILEGES ON SEQUENCE ${objectList(sequences)} FROM ${BROWSER_ROLES};`,
    );
  }
  // ROUTINE covers functions, procedures and aggregates alike.
  if (functions.length > 0) {
    const signatures = functions.map(functionSignature).join(', ');
    statements.push(
      `REVOKE ALL PRIVILEGES ON ROUTINE ${signatures} FROM ${BROWSER_ROLES}, PUBLIC;`,
    );
  }

  // A table created after this runs must not inherit the grants back.
  statements.push(...defaultPrivileges((kind) => `REVOKE ALL ON ${kind} FROM ${BROWSER_ROLES}`));

  // The *global* form: it is the global default that supplies the built-in
  // EXECUTE to PUBLIC for a new function, so a schema-scoped revoke leaves it.
  statements.push(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  );

  return statements;
}

/**
 * The statements that shut former runtime roles out and let the current one
 * in. A former role loses its grants, its default privileges and its LOGIN;
 * the role itself is kept, so dropping it stays an optional manual step.
 *
 * @param appRole The runtime role, or null when the backend connects as the owner.
 * @param formerRoles Roles marked as runtime roles earlier (see `appRole.ts`).
 */
export function buildAppAccessStatements(
  { tables, sequences }: Pick<PublicObjects, 'tables' | 'sequences'>,
  appRole: string | null,
  formerRoles: string[],
): string[] {
  const statements: string[] = [];

  const former = formerRoles.filter((role) => role !== appRole);
  if (former.includes(OWNER_ROLE)) {
    throw new Error(`The table owner (${OWNER_ROLE}) cannot be shut out as a former role.`);
  }
  if (former.length > 0) {
    const roles = former.map(quoteIdentifier).join(', ');
    for (const kind of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
      statements.push(`REVOKE ALL PRIVILEGES ON ALL ${kind} IN SCHEMA public FROM ${roles};`);
    }
    statements.push(...defaultPrivileges((kind) => `REVOKE ALL ON ${kind} FROM ${roles}`));
    statements.push(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${roles};`);
    statements.push(...former.map((role) => `ALTER ROLE ${quoteIdentifier(role)} NOLOGIN;`));
  }

  if (appRole !== null) {
    statements.push(...buildAppGrantStatements(appRole, tables, sequences));
  }

  return statements;
}

/**
 * The grants and policies that let the runtime role read and write the rows.
 * The table grants are revoked first so a privilege granted by hand
 * (TRUNCATE, say) does not survive.
 */
function buildAppGrantStatements(appRole: string, tables: string[], sequences: string[]): string[] {
  const role = quoteIdentifier(appRole);
  if (appRole === OWNER_ROLE) {
    throw new Error(`The runtime role cannot be the table owner (${OWNER_ROLE}).`);
  }

  const statements = [`GRANT USAGE ON SCHEMA public TO ${role};`];

  if (tables.length > 0) {
    statements.push(`REVOKE ALL PRIVILEGES ON TABLE ${objectList(tables)} FROM ${role};`);
    statements.push(`GRANT ${APP_TABLE_PRIVILEGES} ON TABLE ${objectList(tables)} TO ${role};`);
  }

  for (const table of tables) {
    const quoted = quoteIdentifier(table);
    statements.push(`DROP POLICY IF EXISTS ${APP_POLICY} ON public.${quoted};`);
    statements.push(
      `CREATE POLICY ${APP_POLICY} ON public.${quoted} FOR ALL TO ${role} USING (true) WITH CHECK (true);`,
    );
  }

  if (sequences.length > 0) {
    statements.push(
      `GRANT ${APP_SEQUENCE_PRIVILEGES} ON SEQUENCE ${objectList(sequences)} TO ${role};`,
    );
  }

  statements.push(
    ...defaultPrivileges(
      (kind) =>
        `GRANT ${kind === 'TABLES' ? APP_TABLE_PRIVILEGES : APP_SEQUENCE_PRIVILEGES} ON ${kind} TO ${role}`,
    ),
  );

  return statements;
}
