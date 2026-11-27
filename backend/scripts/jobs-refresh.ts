import 'dotenv/config';
import pino from 'pino';
<<<<<<< HEAD
import { createJobRefreshService } from '../src/services/jobHunt/jobRefreshService';
import { getDefaultJobKnowledgeAccess } from '../src/services/jobHunt/knowledgeSource';
=======
import { createStandaloneJobRefreshService } from '../src/services/jobHunt/standalone';
>>>>>>> origin/main
import { reapStaleRefreshes } from '../src/services/jobHunt/staleRefreshReaper';
import * as jobService from '../src/db/api/job';
import * as profileJobService from '../src/db/api/profileJob';
import * as profileService from '../src/db/api/profile';
import * as refreshStatusService from '../src/db/api/refreshStatus';
import type { RefreshUpdateStatus } from '../src/db/schema/jobHunt';
import { dropMigrationUrl, MIGRATION_URL_WARNING } from '../src/config/migrationUrl';

// Queues refreshes for the job worker, which runs them; this process launches no Chrome. The
// table owner's connection is for the migration scripts only: `env -u` in the command keeps it
// out; this drop (after the hoisted imports) is a backstop.
if (dropMigrationUrl() && process.env.NODE_ENV === 'production') {
  process.stderr.write(`${MIGRATION_URL_WARNING}\n`);
}

/** How long --wait lets a refresh stay queued before saying no worker picked it up. */
const NO_WORKER_MS = 2 * 60_000;
/** How long --wait waits in all. */
const WAIT_TIMEOUT_MS = 90 * 60_000;

interface Args {
  profileIds: number[];
  /** True when the caller asked to wait for the refreshes to finish. */
  wait: boolean;
}

/**
 * Parses the command line.
 *
 * Usage: pnpm jobs:refresh -- --profile 1 [--profile 2] [--wait]
 */
function parseArgs(argv: string[]): Args {
  const profileIds: number[] = [];
  let wait = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--profile' || arg === '-p') {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--profile requires a positive integer profile id, got "${value ?? ''}"`);
      }
      profileIds.push(parsed);
      i += 1;
      continue;
    }

    if (arg === '--wait' || arg === '-w') {
      wait = true;
      continue;
    }

    throw new Error(`Unknown argument "${arg}"`);
  }

  if (profileIds.length === 0) {
    throw new Error('At least one --profile <id> is required');
  }

  return { profileIds, wait };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
<<<<<<< HEAD
  const service = createJobRefreshService({
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    knowledge: getDefaultJobKnowledgeAccess(),
    logger: pino({ level: process.env.LOG_LEVEL ?? 'info' }),
  });
=======
  const service = createStandaloneJobRefreshService(
    pino({ level: process.env.LOG_LEVEL ?? 'info' }),
  );
>>>>>>> origin/main

  const reaped = await reapStaleRefreshes();
  if (reaped > 0) {
    process.stdout.write(`Reaped ${reaped} stale refresh row(s).\n`);
  }

  const refreshIds: number[] = [];

  for (const profileId of args.profileIds) {
    try {
      const { refreshStatusId } = await service.enqueue({ profileId });
      refreshIds.push(refreshStatusId);
      process.stdout.write(`Queued refresh ${refreshStatusId} for profile ${profileId}.\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to queue a refresh for profile ${profileId}: ${message}\n`);
      process.exitCode = 1;
    }
  }

  // Poll until every refresh reaches a terminal state, unless the caller
  // asked to fire and forget.
  if (refreshIds.length === 0 || !args.wait) {
    return;
  }

  const terminal = new Set<RefreshUpdateStatus>(['COMPLETED', 'FAILED']);
  const pending = new Set(refreshIds);
  const started = Date.now();

  while (pending.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const elapsed = Date.now() - started;

    for (const id of pending) {
      const status = await refreshStatusService.getRefreshStatus(id);
      if (!status) {
        pending.delete(id);
        continue;
      }

      process.stdout.write(`Refresh ${id}: ${status.status} - ${status.description ?? ''}\n`);

      if (status.status !== null && terminal.has(status.status)) {
        pending.delete(id);
        if (status.status === 'FAILED') process.exitCode = 1;
      } else if (status.claimedAt === null && elapsed > NO_WORKER_MS) {
        process.stderr.write(
          `No worker picked up refresh ${id}: is the job worker running (pnpm worker:dev)? ` +
            'It stays queued for a worker.\n',
        );
        pending.delete(id);
        process.exitCode = 1;
      } else if (elapsed > WAIT_TIMEOUT_MS) {
        process.stderr.write(`Stopped waiting for refresh ${id}; it is still running.\n`);
        pending.delete(id);
        process.exitCode = 1;
      }
    }
  }
}

main().then(
  () => process.exit(),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
