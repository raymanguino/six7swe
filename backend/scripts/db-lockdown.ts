/**
 * The lockdown `db:secure` and `db:reset` apply after the migrations.
 *
 * Connects as the table owner, provisions the backend's runtime role when
 * `DATABASE_URL` names one (see src/db/appRole.ts), applies the access rules
 * (see src/db/security.ts), then checks the runtime role holds no owner rights.
 */

import postgres from 'postgres';
import {
  assertAppRoleIsSafe,
  provisionAppRole,
  resolveRuntimeRole,
  type RoleCredentials,
} from '../src/db/appRole';
import { applyDatabaseSecurity, OWNER_ROLE, type SecurityResult } from '../src/db/security';
import { type DatabaseTarget, sslOptions } from './db-env';

export interface LockdownResult extends SecurityResult {
  /** The runtime role that was provisioned, or null when the backend connects as the owner. */
  appRole: string | null;
}

/**
 * Provisions the runtime role, locks the tables down and checks the role, in
 * one transaction: a failed check rolls everything back, including the role
 * and its password change, and the deploy fails rather than run the backend
 * with owner rights.
 *
 * @param sql A connection as the table owner.
 * @param app The runtime role, or null when the backend connects as the owner.
 */
export async function applyLockdown(
  sql: postgres.Sql,
  app: RoleCredentials | null,
): Promise<LockdownResult> {
  return sql.begin(async (tx) => {
    if (app) {
      await provisionAppRole(tx, app);
    }
    const result = await applyDatabaseSecurity(tx, app?.role ?? null);
    if (app) {
      await assertAppRoleIsSafe(tx, app.role, OWNER_ROLE);
    }
    return { ...result, appRole: app?.role ?? null };
  });
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

/** One line on which role the backend connects as, for the scripts' output. */
export function describeAppRole(result: LockdownResult): string {
  const former =
    result.formerRoles.length > 0
      ? `Shut out the former runtime role(s) ${result.formerRoles.join(', ')}: grants, ` +
        'default privileges and LOGIN revoked.\n'
      : '';
  return (
    former +
    (result.appRole
      ? `The backend connects as ${result.appRole}: it reads and writes the rows and owns no table.\n`
      : `The backend connects as the table owner (${OWNER_ROLE}). Set DATABASE_MIGRATION_URL to the ` +
        'owner and DATABASE_URL to another role to run it without owner rights.\n')
  );
}
