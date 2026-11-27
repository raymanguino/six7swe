import { setTimeout as delay } from 'node:timers/promises';
import type { RefreshStatus } from '../../db/schema/jobHunt';
import type { JobRefreshRunner } from './jobRefreshService';
import type { RefreshQueue } from './refreshQueue';
import type { RefreshScheduler } from './refreshScheduler';

/**
 * The scraper worker's loop. Every refresh it runs comes from the queue: the
 * API queues user-triggered ones and the scheduler queues scheduled ones, so
 * there is one way to run a refresh. A tick runs at most one claimed refresh
 * and awaits it, and {@link runWorkerLoop} awaits each tick before the next,
 * so a worker process never has two Chromes open. Other modules point here
 * rather than restate this.
 */

interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RefreshWorkerDeps {
  queue: Pick<RefreshQueue, 'claimNext'>;
  runner: Pick<JobRefreshRunner, 'runQueued'>;
  scheduler: Pick<RefreshScheduler, 'tick'>;
  /** Fails a run this worker claimed, fenced by its claim; false when the row is no longer ours. */
  failRun(refresh: RefreshStatus, reason: string): Promise<boolean>;
  /** How often the scheduler is asked whether a scheduled refresh is due. */
  scheduleEveryMs: number;
  logger: Logger;
  now?: () => number;
}

export interface RefreshWorker {
  /**
   * Queues a due scheduled refresh (at most every `scheduleEveryMs`), then,
   * unless `signal` is aborted, claims the oldest queued refresh and runs it
   * to the end. Returns the id it ran, or null. Never throws: a failure is
   * logged and the next tick tries again.
   */
  tick(signal?: AbortSignal): Promise<number | null>;
  /** Fails the run in progress, if any, so its profile is free at once. */
  abandon(reason: string): Promise<void>;
}

export function createRefreshWorker(deps: RefreshWorkerDeps): RefreshWorker {
  const now = deps.now ?? Date.now;
  let lastScheduled = Number.NEGATIVE_INFINITY;
  let running: RefreshStatus | null = null;

  async function schedule(): Promise<void> {
    if (now() - lastScheduled < deps.scheduleEveryMs) return;
    lastScheduled = now();
    try {
      await deps.scheduler.tick();
    } catch (error) {
      deps.logger.error({ err: error }, 'Scheduled refresh tick failed');
    }
  }

  async function tick(signal?: AbortSignal): Promise<number | null> {
    await schedule();
    if (signal?.aborted) return null;

    let refresh: RefreshStatus | null;
    try {
      refresh = await deps.queue.claimNext();
    } catch (error) {
      deps.logger.error({ err: error }, 'Could not claim a queued refresh');
      return null;
    }
    if (!refresh) return null;

    const context = { refreshId: refresh.id, profileId: refresh.profileId };
    deps.logger.info(context, 'Running queued refresh');
    running = refresh;
    try {
      await deps.runner.runQueued(refresh);
    } catch (error) {
      // runQueued records failures on the row; this is a last resort.
      deps.logger.error({ err: error, ...context }, 'Queued refresh crashed');
    } finally {
      running = null;
    }
    return refresh.id;
  }

  async function abandon(reason: string): Promise<void> {
    const refresh = running;
    if (!refresh) return;
    try {
      await deps.failRun(refresh, reason);
    } catch (error) {
      // Stale-claim recovery fails it once its heartbeat stops.
      deps.logger.error({ err: error, refreshId: refresh.id }, 'Could not fail the abandoned run');
    }
  }

  return { tick, abandon };
}

export interface WorkerLoopOptions {
  worker: RefreshWorker;
  /** The wait between ticks. */
  pollMs: number;
  /** Aborted on shutdown: no new tick starts and nothing new is claimed. */
  signal: AbortSignal;
  /** How long shutdown waits for the run in progress before failing it. */
  graceMs: number;
  logger: Logger;
}

export const ABANDONED_ON_SHUTDOWN =
  'The worker stopped before this refresh finished. Start it again.';

/**
 * Ticks until `signal` is aborted, then waits up to `graceMs` for the tick in
 * progress. A run still going after that is failed under this worker's claim,
 * so its profile can be refreshed again straight away instead of after the
 * stale window. A tick that throws is logged and the loop goes on.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  const { worker, pollMs, signal, graceMs, logger } = options;
  const stopped = new Promise<'stopped'>((resolve) => {
    if (signal.aborted) resolve('stopped');
    else signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });

  while (!signal.aborted) {
    const tick = worker.tick(signal).then(
      () => 'done' as const,
      (error: unknown) => {
        logger.error({ err: error }, 'Worker tick failed');
        return 'done' as const;
      },
    );
    if ((await Promise.race([tick, stopped])) === 'stopped') {
      const timer = new AbortController();
      const grace = delay(graceMs, 'timeout' as const, { signal: timer.signal }).catch(
        () => 'done' as const,
      );
      const outcome = await Promise.race([tick, grace]);
      timer.abort();
      if (outcome === 'timeout') await worker.abandon(ABANDONED_ON_SHUTDOWN);
      return;
    }
    await delay(pollMs, undefined, { signal }).catch(() => undefined);
  }
}
