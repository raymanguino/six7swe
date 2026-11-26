import pino from 'pino';
import type { WorkerConfig } from '../../config/worker';
import { runJobFetch } from '../jobFetchers';
import * as jobService from '../../db/api/job';
import * as profileJobService from '../../db/api/profileJob';
import * as profileService from '../../db/api/profile';
import * as refreshStatusService from '../../db/api/refreshStatus';
import { createJobRefreshService, type JobRefreshService } from './jobRefreshService';
import { getDefaultJobKnowledgeAccess } from './knowledgeSource';
import { REFRESH_HEARTBEAT_MS } from './refreshQueue';
import {
  createRefreshScheduler,
  type RefreshScheduler,
  type RefreshSchedulerDeps,
} from './refreshScheduler';

/**
 * Builds a refresh service that runs outside a Fastify request lifecycle.
 *
 * Used by the CLI runner, which has no server to decorate.
 */
export function createStandaloneJobRefreshService(): JobRefreshService {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["x-brain-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
  });

  return createJobRefreshService({
    jobFetchService: {
      runJobFetch: (keywords, geoId, onJobsFetched, onStatus) =>
        runJobFetch(keywords, geoId, onJobsFetched, onStatus, logger),
    },
    jobService,
    profileJobService,
    profileService,
    refreshStatusService,
    knowledge: getDefaultJobKnowledgeAccess(),
    logger,
  });
}

/** The worker's scheduler, reading `refresh_status` through this module. */
export function createStandaloneRefreshScheduler(
  config: WorkerConfig,
  logger: RefreshSchedulerDeps['logger'],
): RefreshScheduler {
  return createRefreshScheduler(config, {
    service: createStandaloneJobRefreshService(),
    getLatestRefreshStartedAt: refreshStatusService.getLatestRefreshStartedAt,
    getRefreshStatus: refreshStatusService.getRefreshStatus,
    logger,
  });
}

const DEFAULT_STALE_MINUTES = 30;

/** Three missed heartbeats: a shorter threshold could reap a live refresh. */
export const MIN_STALE_MINUTES = (3 * REFRESH_HEARTBEAT_MS) / 60_000;

/**
 * `JOB_REFRESH_STALE_MINUTES`, how long a refresh may go without a heartbeat
 * before it is failed. 30 when it is unset or not a finite positive number (a
 * typo must not make the cutoff NaN, which would reap nothing, or zero, which
 * would reap running refreshes), and at least {@link MIN_STALE_MINUTES}.
 */
export function staleRefreshMinutes(raw: string | undefined): number {
  const minutes = Number(raw);
  const parsed =
    raw !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STALE_MINUTES;
  return Math.max(parsed, MIN_STALE_MINUTES);
}

/** How long a refresh may stay queued with no worker claiming it before it is failed. */
const QUEUED_REFRESH_MAX_MS = 6 * 3_600_000;

/** How often a long-lived process (the API, the worker) runs stale-claim recovery. */
export const REAP_INTERVAL_MS = 5 * 60_000;

/**
 * Stale-claim recovery: fails every refresh whose runner, in any process, has
 * not heartbeaten for `staleMinutes`, and every refresh left queued for
 * {@link QUEUED_REFRESH_MAX_MS}. A running refresh heartbeats
 * (`refreshQueue.ts`), so only an abandoned one is reaped; without this a
 * crash mid-refresh would leave the profile's row active forever.
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
 * Runs {@link reapStaleRefreshes} every {@link REAP_INTERVAL_MS}, so a run
 * killed by a deploy (its heartbeat still fresh at the next startup) is
 * failed once its heartbeat goes stale. The timer is unref'd.
 */
export function startStaleRefreshReaper(logger: ReaperLogger): () => void {
  const timer = setInterval(() => {
    reapStaleRefreshes().then(
      (reaped) => {
        if (reaped > 0) logger.warn({ reaped }, 'Marked stale job refreshes as failed');
      },
      (error: unknown) => logger.error({ err: error }, 'Stale refresh reap failed'),
    );
  }, REAP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
