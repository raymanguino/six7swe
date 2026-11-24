import { db } from '../index';
import { assertRuntimeRoleIsSafe } from '../appRole';
import { OWNER_ROLE } from '../security';

/**
 * Throws when the server's own connection (`DATABASE_URL`) holds owner rights:
 * a superuser, an RLS bypass, membership in the owner, or ownership of a
 * `public` object (DEPLOYMENT.md, "Database roles").
 */
export async function assertConnectionRoleIsSafe(): Promise<void> {
  await assertRuntimeRoleIsSafe(db.$client, OWNER_ROLE);
}
