import { db } from '../index';
import { assertRuntimeRoleIsSafe } from '../appRole';
import { OWNER_ROLE } from '../security';
import { WORKER_ROLE_MARKER } from '../workerRole';

/**
 * Throws when the server's own connection (`DATABASE_URL`) holds owner rights:
 * a superuser, an RLS bypass, membership in the owner, or ownership of a
 * `public` object (DEPLOYMENT.md, "Database roles").
 */
export async function assertConnectionRoleIsSafe(): Promise<void> {
  await assertRuntimeRoleIsSafe(db.$client, OWNER_ROLE);
}

/**
 * Throws unless the connection's role is the worker role `db:secure`
 * provisioned (its marker comment), so a worker given the backend's
 * `DATABASE_URL` by mistake does not run with the runtime role's rights.
 */
export async function assertConnectionIsWorkerRole(): Promise<void> {
  const [row] = await db.$client<{ ok: boolean | null }[]>`
    select shobj_description(r.oid, 'pg_authid') = ${WORKER_ROLE_MARKER} || ':' || current_database()
      as ok
    from pg_roles r where r.rolname = current_user
  `;
  if (!row?.ok) {
    throw new Error('DATABASE_URL must connect as the worker role db:secure provisioned.');
  }
}
