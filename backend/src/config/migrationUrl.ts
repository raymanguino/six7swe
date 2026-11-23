/**
 * The table owner's connection string, which only the migration scripts use.
 *
 * The backend connects with `DATABASE_URL`, a role that cannot change the
 * schema. `DATABASE_MIGRATION_URL` connects as the table owner and is meant
 * for `db:migrate`, `db:secure` and `db:reset` alone. On Railway it is a
 * variable of the backend service, because the pre-deploy command runs there,
 * so the start command removes it (`env -u DATABASE_MIGRATION_URL`) before the
 * server or Chrome ever sees it.
 */
export const MIGRATION_URL_VARIABLE = 'DATABASE_MIGRATION_URL';

/**
 * Removes the owner's connection string from this process's environment.
 *
 * A second line of defence behind the start command: the server and the
 * refresh runner call it first, so nothing in the process can read the
 * variable and the Chrome the scraper launches does not inherit it. It cannot
 * scrub `/proc/<pid>/environ`, which keeps the environment the process started
 * with, which is why the start command has to remove it as well.
 *
 * @returns True when the variable was set, so the caller can warn.
 */
export function dropMigrationUrl(env: Record<string, string | undefined> = process.env): boolean {
  if (env[MIGRATION_URL_VARIABLE] === undefined) {
    return false;
  }
  delete env[MIGRATION_URL_VARIABLE];
  return true;
}

/** The warning logged when a production process started with the variable set. */
export const MIGRATION_URL_WARNING =
  `${MIGRATION_URL_VARIABLE} was set when this process started. It was removed, but the ` +
  'process environment still holds it: start the process with ' +
  `\`env -u ${MIGRATION_URL_VARIABLE}\` (see DEPLOYMENT.md).`;
