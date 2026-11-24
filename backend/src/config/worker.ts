/**
 * The scraper worker's configuration (`src/worker.ts`, #243).
 *
 * The worker is the process that launches the `--no-sandbox` Chrome, so it
 * holds only what scraping and scoring need: `DATABASE_URL` (the worker role,
 * which reaches only the refresh's tables), `MINIMAX_API_KEY`, and the
 * knowledge retrieval variables the scoring reads background from. A
 * production worker started with a variable it must never hold refuses to
 * start, so a copied variable set fails the deploy instead of widening what a
 * compromised Chrome could read.
 */

/** Variables the worker must never receive: owner and worker-provisioning URLs, mail, auth, the owner proxy key. */
export const WORKER_FORBIDDEN_VARIABLES = [
  'DATABASE_MIGRATION_URL',
  'DATABASE_WORKER_URL',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_FROM_NAME',
  'CONTACT_TO_EMAIL',
  'SUPABASE_URL',
  'SUPABASE_JWKS_URL',
  'SUPABASE_SECRET_KEY',
  'KNOWLEDGE_OWNER_KEY',
] as const;

/** Variables the worker cannot run without. */
const WORKER_REQUIRED_VARIABLES = ['DATABASE_URL', 'MINIMAX_API_KEY'] as const;

/** How often the worker checks whether a scheduled refresh is due. */
export const WORKER_TICK_MS = 5 * 60_000;

const DEFAULT_INTERVAL_HOURS = 24;

export interface WorkerConfig {
  /** The search profiles refreshed on schedule (`JOB_REFRESH_PROFILE_IDS`); empty: none. */
  profileIds: number[];
  /** How long after a profile's last refresh the next one is due (`JOB_REFRESH_INTERVAL_HOURS`). */
  intervalMs: number;
}

/** `process.env`, or a plain object in tests. */
type EnvSource = Record<string, string | undefined>;

function isSet(env: EnvSource, key: string): boolean {
  return Boolean(env[key]?.trim());
}

/** Parses `JOB_REFRESH_PROFILE_IDS`, a comma-separated list of profile ids. */
function parseProfileIds(raw: string | undefined, problems: string[]): number[] {
  const ids: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim();
    if (value === '') continue;
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) {
      problems.push(`JOB_REFRESH_PROFILE_IDS: "${value}" is not a profile id`);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseIntervalHours(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 1) {
    problems.push('JOB_REFRESH_INTERVAL_HOURS must be a number of hours, at least 1');
    return DEFAULT_INTERVAL_HOURS;
  }
  return hours;
}

/**
 * Reads and checks the worker's environment. Throws one error naming every
 * problem (names only, never values: several are secrets).
 */
export function loadWorkerConfig(env: EnvSource = process.env): WorkerConfig {
  const problems: string[] = [];

  for (const key of WORKER_REQUIRED_VARIABLES) {
    if (!isSet(env, key)) problems.push(`${key} is required`);
  }
  if (env.NODE_ENV === 'production') {
    const forbidden = WORKER_FORBIDDEN_VARIABLES.filter((key) => env[key] !== undefined);
    if (forbidden.length > 0) {
      problems.push(`the worker must not receive ${forbidden.join(', ')}`);
    }
  }

  const profileIds = parseProfileIds(env.JOB_REFRESH_PROFILE_IDS, problems);
  const intervalHours = parseIntervalHours(env.JOB_REFRESH_INTERVAL_HOURS, problems);

  if (problems.length > 0) {
    throw new Error(`Invalid worker configuration: ${problems.join('; ')}`);
  }
  return { profileIds, intervalMs: intervalHours * 60 * 60_000 };
}
