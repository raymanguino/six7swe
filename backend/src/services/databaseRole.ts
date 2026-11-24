import * as runtimeRoleService from '../db/api/runtimeRole';

/**
 * Refuses to serve with the table owner's rights. Run at production startup,
 * so a `DATABASE_URL` pointed back at the owner fails the deploy instead of
 * silently undoing the runtime role.
 */
export async function assertServerRoleIsSafe(): Promise<void> {
  await runtimeRoleService.assertConnectionRoleIsSafe();
}
