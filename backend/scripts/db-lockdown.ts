/**
 * The lockdown `db:secure` and `db:reset` apply after the migrations.
 *
 * Connects as the table owner, provisions the backend's runtime role when
 * `DATABASE_URL` names one (see src/db/appRole.ts), then applies the access
 * rules (see src/db/security.ts).
 */

import postgres from 'postgres';
import { provisionAppRole, resolveRuntimeRole } from '../src/db/appRole';
import { applyDatabaseSecurity, OWNER_ROLE, type SecurityResult } from '../src/db/security';
import { type DatabaseTarget, sslOptions } from './db-env';

export interface LockdownResult extends SecurityResult {
  /** The runtime role that was provisioned, or null when the backend connects as the owner. */
  appRole: string | null;
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
    if (app) {
      await provisionAppRole(sql, app, OWNER_ROLE);
    }
    const result = await applyDatabaseSecurity(sql, app?.role ?? null);
    return { ...result, appRole: app?.role ?? null };
  } finally {
    await sql.end();
  }
}

/** One line on which role the backend connects as, for the scripts' output. */
export function describeAppRole(result: LockdownResult): string {
  return result.appRole
    ? `The backend connects as ${result.appRole}: it reads and writes the rows and owns no table.\n`
    : `The backend connects as the table owner (${OWNER_ROLE}). Set DATABASE_MIGRATION_URL to the ` +
        'owner and DATABASE_URL to another role to run it without owner rights.\n';
}
