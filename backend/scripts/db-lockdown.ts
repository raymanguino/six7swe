/**
 * The lockdown `db:secure` and `db:reset` apply after the migrations.
 *
 * Connects as the table owner, closes `public` to the browser roles (see
 * src/db/security.ts), then provisions the backend's runtime role when
 * `DATABASE_URL` names one (see src/db/appRole.ts) and lets it in.
 */

import postgres from 'postgres';
import {
  assertAppRoleIsSafe,
  provisionAppRole,
  resolveRuntimeRole,
  type RoleCredentials,
} from '../src/db/appRole';
import { buildAppAccessStatements, buildLockdownStatements } from '../src/db/lockdownStatements';
import { OWNER_ROLE } from '../src/db/security';
import {
  readExposedDefinerRoutines,
  readFormerRoles,
  readPublicObjects,
  type SkippedFunction,
  terminateRoleSessions,
} from '../src/db/securityCatalog';
import { type DatabaseTarget, sslOptions } from './db-env';

export interface LockdownResult {
  /** The tables that were locked down. */
  tables: string[];
  /** The statements that were applied. */
  statements: number;
  /** The runtime role that was provisioned, or null when the backend connects as the owner. */
  appRole: string | null;
  /** The former runtime roles that were shut out. */
  formerRoles: string[];
  /** The sessions of former roles that were ended. */
  endedSessions: number;
  /** Routines in `public` the owner cannot revoke (not its own, or an extension's). */
  skippedFunctions: SkippedFunction[];
}

async function run(tx: postgres.TransactionSql, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await tx.unsafe(statement);
  }
}

/**
 * Applies the lockdown in two transactions.
 *
 * 1. The browser roles are shut out (RLS, revokes from anon, authenticated and
 *    PUBLIC, default privileges) and that is committed on its own, so nothing
 *    that goes wrong with the runtime role can reopen the tables.
 * 2. The runtime role is created or its password reset, former runtime roles
 *    are shut out, the role is granted its rows and then checked. All or
 *    nothing: a failed check rolls the role, its password and its grants back.
 *
 * Then the sessions of the former roles are ended (best effort), and the run
 * fails if anon, authenticated or PUBLIC can still execute a SECURITY DEFINER
 * routine in `public`.
 *
 * @param sql A connection as the table owner.
 * @param app The runtime role, or null when the backend connects as the owner.
 */
export async function applyLockdown(
  sql: postgres.Sql,
  app: RoleCredentials | null,
): Promise<LockdownResult> {
  const lockdown = await sql.begin(async (tx) => {
    const objects = await readPublicObjects(tx);
    const statements = buildLockdownStatements(objects);
    await run(tx, statements);
    return { objects, statements: statements.length };
  });

  const access = await sql.begin(async (tx) => {
    if (app) {
      await provisionAppRole(tx, app);
    }
    const formerRoles = await readFormerRoles(tx, app?.role ?? null);
    const statements = buildAppAccessStatements(lockdown.objects, app?.role ?? null, formerRoles);
    await run(tx, statements);
    if (app) {
      await assertAppRoleIsSafe(tx, app.role, OWNER_ROLE);
    }
    return { formerRoles, statements: statements.length };
  });

  const endedSessions = await terminateRoleSessions(sql, access.formerRoles);

  const exposed = await readExposedDefinerRoutines(sql);
  if (exposed.length > 0) {
    throw new Error(
      `SECURITY DEFINER routines in public are executable by the browser roles: ${exposed.join('; ')}.`,
    );
  }

  return {
    tables: lockdown.objects.tables,
    statements: lockdown.statements + access.statements,
    appRole: app?.role ?? null,
    formerRoles: access.formerRoles,
    endedSessions,
    skippedFunctions: lockdown.objects.skippedFunctions,
  };
}

export async function lockDownDatabase(target: DatabaseTarget): Promise<LockdownResult> {
  const app = resolveRuntimeRole(
    target.databaseUrl,
    target.appDatabaseUrl,
    OWNER_ROLE,
    target.strict,
  );
  // `DROP POLICY IF EXISTS` raises a notice for every table without the policy yet, which would
  // only clutter the deploy log.
  const sql = postgres(target.databaseUrl, {
    ...sslOptions(target.remote),
    max: 1,
    onnotice: () => undefined,
  });

  try {
    return await applyLockdown(sql, app);
  } finally {
    await sql.end();
  }
}

/** What the lockdown did beyond the tables, for the scripts' output. */
export function describeAppRole(result: LockdownResult): string {
  const lines = result.skippedFunctions.map(
    (fn) =>
      `  ${fn.signature}: owned by ${fn.owner}` +
      (fn.extension ? `, part of extension ${fn.extension}` : '') +
      (fn.definer ? ', SECURITY DEFINER: check by hand who can execute it' : ''),
  );
  if (lines.length > 0) {
    lines.unshift(`Skipped ${lines.length} routine(s) in public the owner cannot revoke:`);
  }
  if (result.formerRoles.length > 0) {
    lines.push(
      `Shut out the former runtime role(s) ${result.formerRoles.join(', ')}: grants, default ` +
        `privileges and LOGIN revoked, ${result.endedSessions} session(s) ended.`,
    );
  }
  lines.push(
    result.appRole
      ? `The backend connects as ${result.appRole}: it reads and writes the rows and owns no table.`
      : `The backend connects as the table owner (${OWNER_ROLE}). Set DATABASE_MIGRATION_URL to the ` +
          'owner and DATABASE_URL to another role to run it without owner rights.',
  );
  return `${lines.join('\n')}\n`;
}
