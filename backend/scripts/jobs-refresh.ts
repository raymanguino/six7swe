import 'dotenv/config';
import {
  createStandaloneJobRefreshService,
  reapStaleRefreshes,
} from '../src/services/jobHunt/standalone';
import * as refreshStatusService from '../src/db/api/refreshStatus';

interface Args {
  profileIds: number[];
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
      if (!value || Number.isNaN(parsed)) {
        throw new Error(`--profile requires a numeric profile id, got "${value ?? ''}"`);
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

  return { profileIds };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const service = createStandaloneJobRefreshService();

  const reaped = await reapStaleRefreshes();
  if (reaped > 0) {
    process.stdout.write(`Reaped ${reaped} stale refresh row(s).\n`);
  }

  const refreshIds: number[] = [];

  for (const profileId of args.profileIds) {
    try {
      const { refreshStatusId } = await service.start({ profileId });
      refreshIds.push(refreshStatusId);
      process.stdout.write(`Started refresh ${refreshStatusId} for profile ${profileId}.\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed to start refresh for profile ${profileId}: ${message}\n`);
      process.exitCode = 1;
    }
  }

  if (refreshIds.length === 0) {
    return;
  }

  if (!args.profileIds.length) return;

  // Poll until every refresh reaches a terminal state, unless the caller
  // asked to fire and forget.
  const waitForCompletion = process.argv.includes('--wait') || process.argv.includes('-w');
  if (!waitForCompletion) {
    return;
  }

  const terminal = new Set(['COMPLETED', 'FAILED']);
  const pending = new Set(refreshIds);

  while (pending.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (const id of pending) {
      const status = await refreshStatusService.getRefreshStatus(id);
      if (!status) {
        pending.delete(id);
        continue;
      }

      process.stdout.write(`Refresh ${id}: ${status.status} - ${status.description ?? ''}\n`);

      if (terminal.has(status.status)) {
        pending.delete(id);
        if (status.status === 'FAILED') {
          process.exitCode = 1;
        }
      }
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
