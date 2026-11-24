import {
  isReservedRole,
  MIN_APP_PASSWORD_LENGTH,
  type RoleCredentials,
  roleFromUrl,
} from './appRole';
import { quoteIdentifier } from './identifier';
import {
  buildFormerRoleStatements,
  objectList,
  type PublicObjects,
  revokeEverythingInPublic,
} from './lockdownStatements';
import { OWNER_ROLE } from './security';

/**
 * The scraper worker's database role (#243).
 *
 * The worker is the process that launches the `--no-sandbox` Chrome, so its
 * `DATABASE_URL` names a role that reaches only what a job refresh reads or
 * writes. `db:secure` provisions it from `DATABASE_WORKER_URL` (a variable of
 * the backend service, where the pre-deploy runs) the way it provisions the
 * runtime role from `DATABASE_URL` (`appRole.ts`), with the same checks.
 *
 * Unlike the runtime role it gets no default privileges: a table added later
 * stays closed to the worker until it is listed in `WORKER_TABLE_ACCESS`.
 */

/** The comment on the worker role, followed by `:` and the database name. */
export const WORKER_ROLE_MARKER = 'six7swe-worker';

/** One fixed name, so a change of worker role replaces the policy. */
export const WORKER_POLICY = 'job_worker_access';

/** The variable `db:secure` reads the worker role's connection string from. */
export const WORKER_URL_VARIABLE = 'DATABASE_WORKER_URL';

interface TableAccess {
  /** Table privileges, optionally with a column list. */
  privileges: string;
  /** The commands the RLS policy admits. */
  policy: 'ALL' | 'SELECT';
}

const READ_WRITE: TableAccess = { privileges: 'SELECT, INSERT, UPDATE', policy: 'ALL' };

/**
 * What a refresh touches (`services/jobHunt/jobRefreshService.ts` and
 * `standalone.ts`): it reads the profile, writes postings, matches and its
 * status row, and reads the profile owner's auth subject to decide whether the
 * profile is scored against the knowledge base. Only `users.id` and
 * `users.auth_id` are readable, never the email or name. Nothing is deleted.
 */
export const WORKER_TABLE_ACCESS: Readonly<Record<string, TableAccess>> = {
  jobs: READ_WRITE,
  profile_jobs: READ_WRITE,
  refresh_status: READ_WRITE,
  profiles: { privileges: 'SELECT', policy: 'SELECT' },
  users: { privileges: 'SELECT (id, auth_id)', policy: 'SELECT' },
};

/**
 * The worker role to provision, or null when `DATABASE_WORKER_URL` is unset
 * (no worker deployed). Validated before any SQL runs: the worker role must be
 * a role of its own, neither the owner nor the backend's runtime role, with a
 * password as long as the runtime role's.
 *
 * @param appRole The runtime role's name, or null when the backend connects as the owner.
 */
export function resolveWorkerRole(
  workerUrl: string | undefined,
  ownerRole: string,
  appRole: string | null,
): RoleCredentials | null {
  if (!workerUrl) {
    return null;
  }
  const worker = roleFromUrl(workerUrl);
  if (worker.role === ownerRole || worker.role === OWNER_ROLE) {
    throw new Error(`${WORKER_URL_VARIABLE} must not connect as the table owner.`);
  }
  if (worker.role === appRole) {
    throw new Error(`${WORKER_URL_VARIABLE} must name a role other than DATABASE_URL's.`);
  }
  if (isReservedRole(worker.role)) {
    throw new Error(`${WORKER_URL_VARIABLE} names the reserved role ${worker.role}.`);
  }
  if (worker.password.length < MIN_APP_PASSWORD_LENGTH) {
    throw new Error(
      `${WORKER_URL_VARIABLE}'s password must be at least ${MIN_APP_PASSWORD_LENGTH} characters ` +
        '(openssl rand -hex 32).',
    );
  }
  return worker;
}

/**
 * The statements that shut former worker roles out and give the current one
 * exactly `WORKER_TABLE_ACCESS`. Everything the role held in `public` is
 * revoked first, so a grant made by hand, or one for a table no longer
 * listed, does not survive.
 *
 * @param workerRole The worker role, or null when none is configured.
 * @param formerRoles Roles marked as worker roles earlier.
 */
export function buildWorkerAccessStatements(
  { tables, sequences }: Pick<PublicObjects, 'tables' | 'sequences'>,
  workerRole: string | null,
  formerRoles: string[],
): string[] {
  const statements = buildFormerRoleStatements(formerRoles, workerRole);
  const present = new Set(tables);

  if (workerRole !== null) {
    if (workerRole === OWNER_ROLE) {
      throw new Error(`The worker role cannot be the table owner (${OWNER_ROLE}).`);
    }
    const missing = Object.keys(WORKER_TABLE_ACCESS).filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(
        `The worker role's tables are missing from public: ${missing.join(', ')}. ` +
          'Update WORKER_TABLE_ACCESS in src/db/workerRole.ts.',
      );
    }
    const role = quoteIdentifier(workerRole);
    statements.push(`GRANT USAGE ON SCHEMA public TO ${role};`, ...revokeEverythingInPublic(role));
  }

  // The policy goes from every table, so one for a table no longer listed does not linger.
  for (const table of tables) {
    statements.push(`DROP POLICY IF EXISTS ${WORKER_POLICY} ON public.${quoteIdentifier(table)};`);
  }

  if (workerRole === null) {
    return statements;
  }

  const role = quoteIdentifier(workerRole);
  for (const [table, access] of Object.entries(WORKER_TABLE_ACCESS)) {
    const quoted = quoteIdentifier(table);
    statements.push(`GRANT ${access.privileges} ON TABLE public.${quoted} TO ${role};`);
    statements.push(
      `CREATE POLICY ${WORKER_POLICY} ON public.${quoted} FOR ${access.policy} TO ${role} ` +
        (access.policy === 'ALL' ? 'USING (true) WITH CHECK (true);' : 'USING (true);'),
    );
  }

  // `serial` ids: the tables the worker inserts into need their sequences.
  const inserted = Object.entries(WORKER_TABLE_ACCESS)
    .filter(([, access]) => access.privileges.includes('INSERT'))
    .map(([table]) => `${table}_id_seq`);
  const missingSequences = inserted.filter((sequence) => !sequences.includes(sequence));
  if (missingSequences.length > 0) {
    throw new Error(`The worker role's sequences are missing: ${missingSequences.join(', ')}.`);
  }
  statements.push(`GRANT USAGE, SELECT ON SEQUENCE ${objectList(inserted)} TO ${role};`);

  return statements;
}
