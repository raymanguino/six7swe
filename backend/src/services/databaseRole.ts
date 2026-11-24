import * as runtimeRoleService from '../db/api/runtimeRole';

/**
 * Refuses to serve with the table owner's rights. Run at production startup,
 * so a `DATABASE_URL` pointed back at the owner fails the deploy instead of
 * silently undoing the runtime role.
 */
export async function assertServerRoleIsSafe(): Promise<void> {
  await runtimeRoleService.assertConnectionRoleIsSafe();
}

/** The worker's check: no owner rights, and connected as the worker role `db:secure` made. */
export async function assertWorkerRoleIsSafe(): Promise<void> {
  await runtimeRoleService.assertConnectionRoleIsSafe();
  await runtimeRoleService.assertConnectionIsWorkerRole();
}
