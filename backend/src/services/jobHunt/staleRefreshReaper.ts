import * as refreshStatusService from '../../db/api/refreshStatus';
import { REFRESH_HEARTBEAT_MS } from './refreshQueue';

/**
 * Stale-claim recovery, run by the API and the worker. Kept apart from
 * `standalone.ts`, which wires in the scraper: the API must never load it.
 */

const DEFAULT_STALE_MINUTES = 30;

/** Three missed heartbeats: a shorter threshold could reap a live refresh. */
const MIN_STALE_MINUTES = (3 * REFRESH_HEARTBEAT_MS) / 60_000;

/**
 * `JOB_REFRESH_STALE_MINUTES`, how long a refresh may go without a heartbeat
 * before it is failed. 30 when it is unset or not a finite positive number (a
 * typo must not make the cutoff NaN, which would reap nothing, or zero, which
 * would reap running refreshes), and at least {@link MIN_STALE_MINUTES}.
 */
function staleRefreshMinutes(raw: string | undefined): number {
  const minutes = Number(raw);
  const parsed = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STALE_MINUTES;
  return Math.max(parsed, MIN_STALE_MINUTES);
}

/**
 * How long a refresh may stay queued, unclaimed, before it is failed. An idle
 * worker claims within seconds, so a row only waits while the one worker runs
 * other refreshes. A refresh is one LinkedIn search page (about 25 postings)
 * plus scoring, three at a time: a few minutes normally, about 40 at worst
 * (every posting page hitting its 10 s waits and 3 retries, every score
 * its 120 s model timeout). An hour covers waiting behind one worst-case run,
 * and a queued row with no worker at all frees its profile within the hour.
 */
const QUEUED_REFRESH_MAX_MS = 60 * 60_000;

/** How often a long-lived process (the API, the worker) runs stale-claim recovery. */
const REAP_INTERVAL_MS = 5 * 60_000;

/**
 * Stale-claim recovery: fails every refresh whose runner, in any process, has
 * not heartbeaten for `staleMinutes`, and every refresh left queued for
 * {@link QUEUED_REFRESH_MAX_MS} (or twice the stale window, if longer). A
 * running refresh heartbeats (`refreshQueue.ts`), so only an abandoned one is
 * reaped; without this a crash mid-refresh would leave the profile's row
 * active forever.
 */
export async function reapStaleRefreshes(
  staleMinutes = staleRefreshMinutes(process.env.JOB_REFRESH_STALE_MINUTES),
): Promise<number> {
  const staleMs = staleMinutes * 60_000;
  const now = Date.now();
  return refreshStatusService.failStaleRefreshes(
    new Date(now - staleMs),
    new Date(now - Math.max(QUEUED_REFRESH_MAX_MS, 2 * staleMs)),
  );
}

interface ReaperLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Runs {@link reapStaleRefreshes} once, so refreshes a crashed process left
 * are failed before this one starts, then every {@link REAP_INTERVAL_MS}, so a
 * run killed by a deploy (its heartbeat still fresh at startup) is failed once
 * its heartbeat goes stale. The first sweep's error is thrown; later ones are
 * logged. The timer is unref'd.
 */
export async function startStaleRefreshReaper(logger: ReaperLogger): Promise<() => void> {
  const report = (reaped: number): void => {
    if (reaped > 0) logger.warn({ reaped }, 'Marked stale job refreshes as failed');
  };
  report(await reapStaleRefreshes());
  const timer = setInterval(() => {
    reapStaleRefreshes().then(report, (error: unknown) =>
      logger.error({ err: error }, 'Stale refresh reap failed'),
    );
  }, REAP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
