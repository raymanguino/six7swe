import type { RefreshStatus } from '../../db/schema/jobHunt';
import type { WorkerConfig } from '../../config/worker';
import { RefreshInProgressError, type JobRefreshService } from './jobRefreshService';

/**
 * The scraper worker's scheduled refresh. Each tick starts at most one, and
 * none while the worker's last one runs, so it never runs two Chromes. A
 * profile is due when its latest refresh (from any process, read from
 * `refresh_status`, so a restart keeps the schedule) is older than the
 * interval; one that could not start waits out the interval too.
 */

interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RefreshSchedulerDeps {
  service: Pick<JobRefreshService, 'start'>;
  getLatestRefreshStartedAt(profileId: number): Promise<Date | null>;
  getRefreshStatus(id: number): Promise<Pick<RefreshStatus, 'status'> | null>;
  reapStaleRefreshes(): Promise<number>;
  logger: Logger;
  now?: () => number;
}

export interface RefreshScheduler {
  /** Starts the next due refresh, if any. Returns the refresh id it started, or null. */
  tick(): Promise<number | null>;
}

export function createRefreshScheduler(
  config: WorkerConfig,
  deps: RefreshSchedulerDeps,
): RefreshScheduler {
  const now = deps.now ?? Date.now;
  /** The refresh this worker started last, while it may still be running. */
  let running: number | null = null;
  /** When a refresh could not be started, by profile. */
  const attempted = new Map<number, number>();

  async function stillRunning(): Promise<boolean> {
    if (running === null) return false;
    const row = await deps.getRefreshStatus(running);
    if (row && (row.status === 'PENDING' || row.status === 'IN_PROGRESS')) return true;
    running = null;
    return false;
  }

  async function isDue(profileId: number): Promise<boolean> {
    const last = await deps.getLatestRefreshStartedAt(profileId);
    const since = Math.max(last?.getTime() ?? 0, attempted.get(profileId) ?? 0);
    return now() - since >= config.intervalMs;
  }

  async function tick(): Promise<number | null> {
    if (config.profileIds.length === 0 || (await stillRunning())) return null;

    const reaped = await deps.reapStaleRefreshes();
    if (reaped > 0) deps.logger.info({ reaped }, 'Reaped stale refreshes');

    for (const profileId of config.profileIds) {
      if (!(await isDue(profileId))) continue;
      try {
        const { refreshStatusId } = await deps.service.start({ profileId });
        running = refreshStatusId;
        deps.logger.info({ profileId, refreshStatusId }, 'Started scheduled refresh');
        return refreshStatusId;
      } catch (error) {
        // Another process holds the profile's refresh: it is not due, and its row resets the clock.
        if (error instanceof RefreshInProgressError) continue;
        attempted.set(profileId, now());
        deps.logger.error({ err: error, profileId }, 'Could not start scheduled refresh');
      }
    }
    return null;
  }

  return { tick };
}
